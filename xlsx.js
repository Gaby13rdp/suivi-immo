/* ============================================================================
   xlsx.js — lecture ET écriture du classeur, sans bibliothèque.
   Utilisable en navigateur et en Node (tests). Aucune dépendance.

   Trois usages :
     analyser(buffer)            → {params, cats, tx, lignes, excel, noms}  (B5, B18)
     greffer(gabarit, donnees)   → Uint8Array : le classeur exporté          (B17)
     ecrireZip(parties)          → Uint8Array : ZIP brut

   La greffe ne recrée rien : elle remplace chirurgicalement la feuille des
   transactions, met à jour les cellules de paramètres LITTÉRALES, force le
   recalcul et neutralise Power Query. Toutes les parties non touchées sont
   recopiées telles quelles, octet pour octet (flux comprimé d'origine).
   ========================================================================== */
(function (root) {
  'use strict';

  /* ---------- utilitaires binaires ------------------------------------- */
  var TABLE_CRC = (function () {
    var t = new Uint32Array(256), c, n, k;
    for (n = 0; n < 256; n++) {
      c = n;
      for (k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(u8) {
    var c = 0xFFFFFFFF;
    for (var i = 0; i < u8.length; i++) c = TABLE_CRC[(c ^ u8[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }
  function texteVersU8(s) { return new TextEncoder().encode(s); }
  function u8VersTexte(u) { return new TextDecoder('utf-8').decode(u); }

  function deflateBrut(u8) {
    if (typeof CompressionStream === 'undefined') return Promise.resolve(null);
    var flux = new Blob([u8]).stream().pipeThrough(new CompressionStream('deflate-raw'));
    return new Response(flux).arrayBuffer().then(function (b) { return new Uint8Array(b); })
      .catch(function () { return null; });
  }
  function inflateBrut(u8) {
    if (typeof DecompressionStream === 'undefined')
      return Promise.reject(new Error('Navigateur trop ancien : utilisez Google Chrome ou Microsoft Edge à jour.'));
    var flux = new Blob([u8]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Response(flux).arrayBuffer().then(function (b) { return new Uint8Array(b); });
  }

  /* ---------- lecture du ZIP -------------------------------------------
     Identique à publier.html, mais on retient aussi crc / tailles / flux
     comprimé : c'est ce qui permet de recopier une partie sans la toucher. */
  function ouvrirZip(buf) {
    var dv = new DataView(buf), fin = -1;
    for (var i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 66000); i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { fin = i; break; }
    }
    if (fin < 0) throw new Error('Ce fichier n’est pas un classeur Excel valide (archive illisible).');
    var nb = dv.getUint16(fin + 10, true), off = dv.getUint32(fin + 16, true);
    var entrees = {}, ordre = [], dec = new TextDecoder('utf-8');
    for (var k = 0; k < nb; k++) {
      if (dv.getUint32(off, true) !== 0x02014b50) throw new Error('Archive Excel corrompue (entrée ' + k + ').');
      var e = {
        methode: dv.getUint16(off + 10, true),
        crc: dv.getUint32(off + 16, true),
        taille: dv.getUint32(off + 20, true),
        brute: dv.getUint32(off + 24, true),
        local: dv.getUint32(off + 42, true)
      };
      var nLen = dv.getUint16(off + 28, true), eLen = dv.getUint16(off + 30, true), cLen = dv.getUint16(off + 32, true);
      var nom = dec.decode(new Uint8Array(buf, off + 46, nLen));
      entrees[nom] = e; ordre.push(nom);
      off += 46 + nLen + eLen + cLen;
    }
    return { buf: buf, dv: dv, entrees: entrees, ordre: ordre };
  }
  function octetsComprimes(zip, nom) {
    var e = zip.entrees[nom]; if (!e) return null;
    var nLen = zip.dv.getUint16(e.local + 26, true), eLen = zip.dv.getUint16(e.local + 28, true);
    var debut = e.local + 30 + nLen + eLen;
    var taille = e.taille;
    if (!taille || taille === 0xffffffff) taille = zip.dv.getUint32(e.local + 18, true);
    return new Uint8Array(zip.buf, debut, taille);
  }
  function lireOctets(zip, nom) {
    var e = zip.entrees[nom];
    if (!e) return Promise.resolve(null);
    var data = octetsComprimes(zip, nom);
    if (e.methode === 0) return Promise.resolve(data);
    if (e.methode !== 8) return Promise.reject(new Error('Compression ZIP non gérée (' + e.methode + ') pour ' + nom));
    return inflateBrut(data);
  }
  function lire(zip, nom) {
    return lireOctets(zip, nom).then(function (u) { return u === null ? null : u8VersTexte(u); });
  }

  /* ---------- écriture du ZIP ------------------------------------------
     parties = [{nom, u8}]                      → à comprimer
             | [{nom, brut, crc, brute, methode}] → recopie telle quelle
     Repli sans CompressionStream : méthode 0 (stored), parfaitement valide. */
  function ecrireZip(parties) {
    var prets = parties.map(function (p) {
      if (p.brut) return Promise.resolve(p);
      return deflateBrut(p.u8).then(function (z) {
        if (z && z.length < p.u8.length) return { nom: p.nom, brut: z, methode: 8, crc: crc32(p.u8), brute: p.u8.length };
        return { nom: p.nom, brut: p.u8, methode: 0, crc: crc32(p.u8), brute: p.u8.length };
      });
    });
    return Promise.all(prets).then(function (liste) {
      var noms = liste.map(function (p) { return texteVersU8(p.nom); });
      var total = 0, i;
      for (i = 0; i < liste.length; i++) total += 30 + noms[i].length + liste[i].brut.length + 46 + noms[i].length;
      total += 22;
      var out = new Uint8Array(total), dv = new DataView(out.buffer), pos = 0, debuts = [];
      for (i = 0; i < liste.length; i++) {
        var p = liste[i]; debuts.push(pos);
        dv.setUint32(pos, 0x04034b50, true);
        dv.setUint16(pos + 4, 20, true);            // version needed
        dv.setUint16(pos + 6, 0x0800, true);        // drapeau : noms en UTF-8
        dv.setUint16(pos + 8, p.methode, true);
        dv.setUint16(pos + 10, 0, true);            // heure
        dv.setUint16(pos + 12, 0x2821, true);       // date : 2000-01-01
        dv.setUint32(pos + 14, p.crc, true);
        dv.setUint32(pos + 18, p.brut.length, true);
        dv.setUint32(pos + 22, p.brute, true);
        dv.setUint16(pos + 26, noms[i].length, true);
        dv.setUint16(pos + 28, 0, true);
        out.set(noms[i], pos + 30);
        out.set(p.brut, pos + 30 + noms[i].length);
        pos += 30 + noms[i].length + p.brut.length;
      }
      var debutCd = pos;
      for (i = 0; i < liste.length; i++) {
        var q = liste[i];
        dv.setUint32(pos, 0x02014b50, true);
        dv.setUint16(pos + 4, 20, true);
        dv.setUint16(pos + 6, 20, true);
        dv.setUint16(pos + 8, 0x0800, true);
        dv.setUint16(pos + 10, q.methode, true);
        dv.setUint16(pos + 12, 0, true);
        dv.setUint16(pos + 14, 0x2821, true);
        dv.setUint32(pos + 16, q.crc, true);
        dv.setUint32(pos + 20, q.brut.length, true);
        dv.setUint32(pos + 24, q.brute, true);
        dv.setUint16(pos + 28, noms[i].length, true);
        dv.setUint16(pos + 30, 0, true);
        dv.setUint16(pos + 32, 0, true);
        dv.setUint16(pos + 34, 0, true);
        dv.setUint16(pos + 36, 0, true);
        dv.setUint32(pos + 38, 0, true);
        dv.setUint32(pos + 42, debuts[i], true);
        out.set(noms[i], pos + 46);
        pos += 46 + noms[i].length;
      }
      dv.setUint32(pos, 0x06054b50, true);
      dv.setUint16(pos + 8, liste.length, true);
      dv.setUint16(pos + 10, liste.length, true);
      dv.setUint32(pos + 12, pos - debutCd, true);
      dv.setUint32(pos + 16, debutCd, true);
      dv.setUint16(pos + 20, 0, true);
      return out.subarray(0, pos + 22);
    });
  }

  /* ---------- XML : lecture portable ------------------------------------
     Volontairement sans DOMParser : le même code doit tourner en Node pour le
     banc de test (B23). Le XML d'Excel est produit par une machine, sans
     commentaires ni CDATA — la lecture par expressions régulières est sûre à
     condition de décoder les entités, ce que fait `dechapper`. */
  function dechapper(s) {
    return String(s).replace(/&(#x?[0-9a-fA-F]+|amp|lt|gt|quot|apos);/g, function (t, e) {
      if (e === 'amp') return '&'; if (e === 'lt') return '<'; if (e === 'gt') return '>';
      if (e === 'quot') return '"'; if (e === 'apos') return "'";
      return String.fromCharCode(e.charAt(1) === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    });
  }
  function attr(balise, nom) {
    var m = new RegExp('\\s' + nom.replace(/:/g, '\\:') + '="([^"]*)"').exec(balise);
    return m ? dechapper(m[1]) : null;
  }
  function chaquBalise(txt, nom, fn) {
    var re = new RegExp('<' + nom + '(\\s[^>]*?)?/>|<' + nom + '(\\s[^>]*?)?>([\\s\\S]*?)</' + nom + '>', 'g'), m;
    while ((m = re.exec(txt)) !== null) fn(m[0], m[3] === undefined ? '' : m[3]);
  }
  function textesT(inner) {
    var out = '', re = /<t(?:\s[^>]*)?\/>|<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g, m;
    while ((m = re.exec(inner)) !== null) out += m[1] === undefined ? '' : dechapper(m[1]);
    return out;
  }
  /* dictionnaire { "C5": valeur } d'une feuille */
  function cellulesDepuisXml(txt, partagees) {
    var res = {}, re = /<c\s([^>]*?)\/>|<c\s([^>]*?)>([\s\S]*?)<\/c>/g, m;
    while ((m = re.exec(txt)) !== null) {
      var attrs = m[1] !== undefined ? m[1] : m[2], inner = m[3] === undefined ? '' : m[3];
      var r = /\br="([^"]*)"/.exec(attrs); if (!r) continue;
      var tt = /\bt="([^"]*)"/.exec(attrs), t = tt ? tt[1] : null, v = null;
      if (t === 'inlineStr') {
        var is = /<is>([\s\S]*?)<\/is>/.exec(inner);
        v = is ? textesT(is[1]) : '';
      } else {
        var vn = /<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/.exec(inner);
        if (!vn) v = null;
        else if (t === 's') v = partagees[parseInt(vn[1], 10)];
        else if (t === 'str' || t === 'e') v = dechapper(vn[1]);
        else if (t === 'b') v = vn[1] === '1';
        else v = parseFloat(vn[1]);
      }
      res[r[1]] = v;
    }
    return res;
  }
  function echapper(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/\u0000/g, '');
  }
  function serieVersDate(n) {
    if (typeof n !== 'number' || !isFinite(n) || n <= 0) return null;
    return new Date(Date.UTC(1899, 11, 30) + Math.round(n) * 86400000).toISOString().slice(0, 10);
  }
  function dateVersSerie(iso) {
    if (!iso) return null;
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso));
    if (!m) return null;
    return Math.round((Date.UTC(+m[1], +m[2] - 1, +m[3]) - Date.UTC(1899, 11, 30)) / 86400000);
  }
  function refDecoupe(ref) {
    var m = /^(?:'((?:[^']|'')+)'|([^!']+))!(.+)$/.exec(ref);
    if (!m) return null;
    return { feuille: m[1] ? m[1].replace(/''/g, "'") : m[2], plage: m[3].replace(/\$/g, '') };
  }
  function colonneVersNum(c) { var n = 0; for (var i = 0; i < c.length; i++) n = n * 26 + (c.charCodeAt(i) - 64); return n; }

  /* ==========================================================================
     ANALYSE (B5 / B18) — même contrat que publier.html, plus le libellé (B14)
     ========================================================================== */
  function analyser(buf, nomFichier, modifieLe) {
    var zip = ouvrirZip(buf), partagees = [], noms = {}, feuilles = {}, cacheF = {};

    function cellules(nomFeuille) {
      if (cacheF[nomFeuille]) return Promise.resolve(cacheF[nomFeuille]);
      var chemin = feuilles[nomFeuille];
      if (!chemin) return Promise.reject(new Error('Onglet « ' + nomFeuille + ' » introuvable dans le classeur.'));
      return lire(zip, chemin).then(function (txt) {
        var res = cellulesDepuisXml(txt, partagees);
        cacheF[nomFeuille] = res;
        return res;
      });
    }
    function parNom(nom) {
      var ref = noms[nom]; if (!ref) return Promise.resolve(null);
      var d = refDecoupe(ref); if (!d) return Promise.resolve(null);
      return cellules(d.feuille).then(function (c) { return c[d.plage.split(':')[0]]; });
    }
    function colonneParNom(nom) {
      var ref = noms[nom]; if (!ref) return Promise.resolve([]);
      var d = refDecoupe(ref); if (!d) return Promise.resolve([]);
      var b = d.plage.split(':');
      var m1 = /^([A-Z]+)(\d+)$/.exec(b[0]), m2 = /^([A-Z]+)(\d+)$/.exec(b[1] || b[0]);
      return cellules(d.feuille).then(function (c) {
        var out = [];
        for (var r = +m1[2]; r <= +m2[2]; r++) out.push(c[m1[1] + r]);
        return out;
      });
    }
    function nombre(v) { return (typeof v === 'number' && isFinite(v)) ? v : 0; }
    function s(x) { return (x === undefined || x === null) ? '' : String(x); }

    var res = {};
    return lire(zip, 'xl/sharedStrings.xml').then(function (ssTxt) {
      if (ssTxt) chaquBalise(ssTxt, 'si', function (tout, inner) { partagees.push(textesT(inner)); });
      return lire(zip, 'xl/workbook.xml');
    }).then(function (wbTxt) {
      if (!wbTxt) throw new Error('Classeur illisible : xl/workbook.xml absent.');
      return lire(zip, 'xl/_rels/workbook.xml.rels').then(function (relsTxt) {
        var cibles = {};
        chaquBalise(relsTxt, 'Relationship', function (t) {
          cibles[attr(t, 'Id')] = attr(t, 'Target').replace(/^\/?xl\//, '').replace(/^\//, '');
        });
        chaquBalise(wbTxt, 'sheet', function (t) {
          feuilles[attr(t, 'name')] = 'xl/' + cibles[attr(t, 'r:id')];
        });
        chaquBalise(wbTxt, 'definedName', function (t, inner) {
          if (attr(t, 'localSheetId') !== null) return;
          noms[attr(t, 'name')] = dechapper(inner);
        });
      });
    }).then(function () {
      var refPrix = refDecoupe(noms['Prix_Achat'] || '');
      return cellules(refPrix ? refPrix.feuille : 'Paramètres');
    }).then(function (cellParams) {
      return Promise.all([
        parNom('Prix_Achat'), parNom('Nb_Studios'), parNom('Date_Acquisition'), parNom('Budget_Travaux'),
        parNom('Frais_Acte_Hors_Releve'), parNom('Emprunt_Total'), parNom('Deblocage_Hors_Compte'),
        parNom('Date_Fin_Differe'), parNom('Mensualite_Hors_Assurance'), parNom('Assurance_Mensuelle'),
        parNom('Cout_Credit_Total')
      ]).then(function (v) {
        res.params = {
          prix_achat: nombre(v[0]), nb_studios: Math.round(nombre(v[1])) || 1,
          ville: String(cellParams['C7'] || ''), date_acquisition: serieVersDate(v[2]),
          budget_travaux: nombre(v[3]), frais_acte_hors_releve: nombre(v[4]), emprunt_total: nombre(v[5]),
          deblocage_hors_compte: nombre(v[6]), date_fin_differe: serieVersDate(v[7]),
          mensualite_hors_assurance: nombre(v[8]), assurance_mensuelle: nombre(v[9]), cout_credit_total: nombre(v[10])
        };
      });
    }).then(function () {
      return Promise.all([colonneParNom('Cat_Nature'), colonneParNom('Cat_CatFin'),
        colonneParNom('Cat_Type'), colonneParNom('Cat_Recurrent')]);
    }).then(function (c) {
      var cats = [];
      for (var i = 0; i < c[0].length; i++) {
        if (c[0][i] === undefined || c[0][i] === null || String(c[0][i]).trim() === '') continue;
        cats.push([String(c[0][i]), s(c[1][i]), s(c[2][i]), s(c[3][i])]);
      }
      res.cats = cats;
      var refTx = refDecoupe(noms['Tx_Date'] || '');
      res.feuilleTx = refTx ? refTx.feuille : 'Transactions';
      return cellules(res.feuilleTx);
    }).then(function (cellTx) {
      var derniere = 1;
      Object.keys(cellTx).forEach(function (r) {
        var m = /^([A-Z]+)(\d+)$/.exec(r);
        if (m && colonneVersNum(m[1]) <= 12 && +m[2] > derniere && cellTx[r] !== null && cellTx[r] !== '') derniere = +m[2];
      });
      var tx = [], lignes = [];
      for (var r = 2; r <= derniere; r++) {
        var date = cellTx['A' + r], lib = cellTx['B' + r], mont = cellTx['E' + r];
        var vide = (date === undefined || date === null || date === '') &&
                   (lib === undefined || lib === null || lib === '') &&
                   (mont === undefined || mont === null || mont === '');
        if (vide) continue;
        tx.push([serieVersDate(date), nombre(mont), s(cellTx['F' + r]), s(cellTx['G' + r]),
                 s(cellTx['H' + r]), s(cellTx['I' + r]),
                 (s(cellTx['J' + r]).trim().toUpperCase() === 'X') ? 1 : 0, s(cellTx['K' + r])]);
        lignes.push({ ligne: r, libelle: s(lib), id: s(cellTx['L' + r]) });
      }
      if (!tx.length) throw new Error('Aucune transaction lue : le classeur a-t-il bien été enregistré après actualisation ?');
      res.tx = tx; res.lignes = lignes;
      return cellules('Dashboard').catch(function () { return null; });
    }).then(function (D) {
      res.excel = null;
      if (D) try {
        var n2 = function (a) { var v = D[a]; return (typeof v === 'number' && isFinite(v)) ? Math.round(v * 100) / 100 : null; };
        var top = [], st = [], det = [], men = [], t1, t2, t3, t4;
        for (t1 = 43; t1 <= 52; t1++) if (D['B' + t1]) top.push([String(D['B' + t1]), n2('C' + t1)]);
        for (t2 = 82; t2 <= 88; t2++) if (D['H' + t2]) st.push([String(D['H' + t2]), n2('I' + t2), n2('J' + t2)]);
        for (t3 = 56; t3 <= 101; t3++) if (D['B' + t3]) det.push([String(D['B' + t3]), n2('D' + t3)]);
        for (t4 = 39; t4 <= 200; t4++) {
          var jour = D['H' + t4];
          if (typeof jour !== 'number' || !isFinite(jour)) break;
          men.push([serieVersDate(jour), n2('I' + t4), n2('J' + t4), n2('L' + t4)]);
        }
        res.excel = {
          cout_total_investissement: n2('C17'), cout_revient: n2('C19'), frais_acquisition: n2('C13'),
          travaux: n2('C14'), ameublement: n2('C15'), autres_invest: n2('C16'), frais_financement: n2('C18'),
          recettes_total: n2('F15'), loyers: n2('F12'), deblocages: n2('F16'), avancement_travaux: n2('F18'),
          depenses_exploitation: n2('C22'), interets: n2('C23'), assurance_emprunteur: n2('C24'),
          couts_reels_total: n2('C26'), capital_debloque: n2('F22'), reste_a_debloquer: n2('F23'),
          capital_rembourse: n2('F24'), dette_restante: n2('F25'), mensualite_apres_differe: n2('F27'),
          loyer_equilibre: n2('F28'), resultat_exploitation: n2('C30'), resultat_courant: n2('C31'),
          cash_flow_cumule: n2('C32'), apport_personnel: n2('C33'), emplois: n2('L15'), ressources: n2('L20'),
          ecart_reconciliation: n2('L21'), cout_credit: n2('L22'),
          top10: top, studios: st, detail_nature: det, mensuel: men
        };
      } catch (e) { res.excel = null; }
      res.noms = noms;
      res.workbook = { nom: nomFichier || '', modified: modifieLe || null };
      res.bien = { titre: 'Immeuble de ' + res.params.nb_studios + ' studios', ville: res.params.ville };
      return res;
    });
  }

  /* ==========================================================================
     GREFFE (B17)
     ========================================================================== */
  var STYLES_TX = { A: '30', B: '23', C: '24', D: '24', E: '24', F: '23', G: '23',
                    H: '23', I: '23', J: '31', K: '23', L: '108' };
  var COL_TX = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L'];

  function cellTexte(ref, style, valeur) {
    if (valeur === null || valeur === undefined || valeur === '')
      return '<c r="' + ref + '" s="' + style + '"/>';
    return '<c r="' + ref + '" s="' + style + '" t="inlineStr"><is><t xml:space="preserve">' +
      echapper(valeur) + '</t></is></c>';
  }
  function cellNombre(ref, style, valeur) {
    if (valeur === null || valeur === undefined || !isFinite(valeur))
      return '<c r="' + ref + '" s="' + style + '"/>';
    return '<c r="' + ref + '" s="' + style + '"><v>' + valeur + '</v></c>';
  }

  /* Construit le <sheetData> de la feuille Transactions.
     lignes = [{date, montant, libelle, nature, catfin, studio, type, exclure, source, id}] */
  function sheetDataTx(enTete, lignes) {
    var out = ['<sheetData>'];
    out.push('<row r="1" spans="1:12">');
    for (var c = 0; c < 12; c++) out.push(cellTexte(COL_TX[c] + '1', '29', enTete[c]));
    out.push('</row>');
    for (var i = 0; i < lignes.length; i++) {
      var l = lignes[i], r = i + 2, m = (typeof l.montant === 'number' && isFinite(l.montant)) ? l.montant : 0;
      out.push('<row r="' + r + '" spans="1:12">');
      out.push(cellNombre('A' + r, STYLES_TX.A, dateVersSerie(l.date)));
      out.push(cellTexte('B' + r, STYLES_TX.B, l.libelle));
      out.push(cellNombre('C' + r, STYLES_TX.C, m < 0 ? Math.round(-m * 100) / 100 : null));
      out.push(cellNombre('D' + r, STYLES_TX.D, m > 0 ? Math.round(m * 100) / 100 : null));
      out.push(cellNombre('E' + r, STYLES_TX.E, Math.round(m * 100) / 100));
      out.push(cellTexte('F' + r, STYLES_TX.F, l.nature));
      out.push(cellTexte('G' + r, STYLES_TX.G, l.catfin));
      out.push(cellTexte('H' + r, STYLES_TX.H, l.studio));
      out.push(cellTexte('I' + r, STYLES_TX.I, l.type));
      out.push(cellTexte('J' + r, STYLES_TX.J, l.exclure ? 'X' : ''));
      out.push(cellTexte('K' + r, STYLES_TX.K, l.source));
      out.push(cellTexte('L' + r, STYLES_TX.L, l.id));
      out.push('</row>');
    }
    out.push('</sheetData>');
    return out.join('');
  }

  function remplacerBloc(xmlTxt, balise, remplacement) {
    var re = new RegExp('<' + balise + '(?:\\s[^>]*?)?/>|<' + balise + '(?:\\s[^>]*?)?>[\\s\\S]*?</' + balise + '>');
    var m = re.exec(xmlTxt);
    if (!m) return null;
    return xmlTxt.slice(0, m.index) + remplacement + xmlTxt.slice(m.index + m[0].length);
  }
  function retirerBloc(xmlTxt, balise) {
    var r = remplacerBloc(xmlTxt, balise, '');
    return r === null ? xmlTxt : r;
  }

  /* Écrit une valeur littérale dans une cellule d'une feuille.
     Une cellule qui porte une FORMULE n'est jamais écrasée : elle est dérivée
     du classeur, l'écraser casserait la présentabilité (A16 n° 8). Renvoie
     {xml, ignorees:[refs]}. */
  function ecrireCellules(xmlTxt, valeurs) {
    var ignorees = [];
    Object.keys(valeurs).forEach(function (ref) {
      var v = valeurs[ref];
      if (v === null || v === undefined) return;
      var re = new RegExp('<c r="' + ref + '"(?:\\s[^>]*)?(?:/>|>[\\s\\S]*?</c>)');
      var m = re.exec(xmlTxt);
      if (!m) { ignorees.push(ref); return; }
      if (m[0].indexOf('<f') >= 0) { ignorees.push(ref); return; }
      var st = /\ss="(\d+)"/.exec(m[0]);
      var style = st ? st[1] : '0';
      var neuf = (typeof v === 'number') ? cellNombre(ref, style, v) : cellTexte(ref, style, v);
      xmlTxt = xmlTxt.slice(0, m.index) + neuf + xmlTxt.slice(m.index + m[0].length);
    });
    return { xml: xmlTxt, ignorees: ignorees };
  }

  /* donnees = {params, lignes:[…], enTete?}
     Renvoie {octets, rapport:{lignes, params_ignores, parties_retirees}} */
  function greffer(bufGabarit, donnees) {
    var zip = ouvrirZip(bufGabarit);
    var rapport = { lignes: donnees.lignes.length, params_ignores: [], parties_retirees: [] };
    var modifiees = {}, retirees = {};
    var etat = {};

    function marquerRetiree(nom) { if (zip.entrees[nom]) { retirees[nom] = 1; rapport.parties_retirees.push(nom); } }

    return lire(zip, 'xl/workbook.xml').then(function (wbTxt) {
      etat.wb = wbTxt;
      etat.noms = {};
      chaquBalise(wbTxt, 'definedName', function (t, inner) {
        if (attr(t, 'localSheetId') !== null) return;
        etat.noms[attr(t, 'name')] = dechapper(inner);
      });
      var cibles = {};
      return lire(zip, 'xl/_rels/workbook.xml.rels').then(function (relsTxt) {
        etat.rels = relsTxt;
        chaquBalise(relsTxt, 'Relationship', function (t) {
          cibles[attr(t, 'Id')] = { cible: attr(t, 'Target'), type: attr(t, 'Type') };
        });
        etat.feuilles = {};
        chaquBalise(wbTxt, 'sheet', function (t) {
          var rid = attr(t, 'r:id');
          etat.feuilles[attr(t, 'name')] =
            'xl/' + cibles[rid].cible.replace(/^\/?xl\//, '').replace(/^\//, '');
        });
        etat.cibles = cibles;
      });
    }).then(function () {
      /* --- 3. feuille Transactions ------------------------------------- */
      var refTx = refDecoupe(etat.noms['Tx_Date'] || '');
      var nomFeuilleTx = refTx ? refTx.feuille : 'Transactions';
      etat.cheminTx = etat.feuilles[nomFeuilleTx];
      if (!etat.cheminTx) throw new Error('Onglet des transactions introuvable dans le gabarit.');
      return lire(zip, etat.cheminTx);
    }).then(function (shTxt) {
      var enTete = donnees.enTete || ['Date', 'Libellé', 'Débit', 'Crédit', 'Montant', 'Nature',
        'Catégorie financière', 'Studio', 'Type', 'Exclure', 'Source', 'ID transaction'];
      var n = donnees.lignes.length + 1;
      var neuf = remplacerBloc(shTxt, 'sheetData', sheetDataTx(enTete, donnees.lignes));
      if (neuf === null) throw new Error('Feuille des transactions illisible (sheetData absent).');
      neuf = neuf.replace(/<dimension ref="[^"]*"\/>/, '<dimension ref="A1:L' + n + '"/>');
      neuf = retirerBloc(neuf, 'tableParts');      // la table Power Query disparaît
      neuf = retirerBloc(neuf, 'autoFilter');
      modifiees[etat.cheminTx] = texteVersU8(neuf);
      marquerRetiree(etat.cheminTx.replace(/\/([^\/]+)$/, '/_rels/$1.rels'));
      /* --- 4. cellules de paramètres ----------------------------------- */
      var refPrix = refDecoupe(etat.noms['Prix_Achat'] || '');
      etat.cheminParams = refPrix ? etat.feuilles[refPrix.feuille] : null;
      if (!etat.cheminParams || !donnees.params) return null;
      return lire(zip, etat.cheminParams);
    }).then(function (paTxt) {
      if (paTxt !== null && paTxt !== undefined) {
        var p = donnees.params, aEcrire = {};
        function pose(nom, valeur) {
          var d = refDecoupe(etat.noms[nom] || ''); if (!d) return;
          aEcrire[d.plage.split(':')[0]] = valeur;
        }
        pose('Prix_Achat', p.prix_achat);
        pose('Nb_Studios', p.nb_studios);
        pose('Date_Acquisition', dateVersSerie(p.date_acquisition));
        pose('Budget_Travaux', p.budget_travaux);
        pose('Frais_Acte_Hors_Releve', p.frais_acte_hors_releve);
        pose('Emprunt_Total', p.emprunt_total);
        pose('Deblocage_Hors_Compte', p.deblocage_hors_compte);
        pose('Date_Fin_Differe', dateVersSerie(p.date_fin_differe));
        pose('Mensualite_Hors_Assurance', p.mensualite_hors_assurance);
        pose('Assurance_Mensuelle', p.assurance_mensuelle);
        pose('Cout_Credit_Total', p.cout_credit_total);
        if (p.ville) aEcrire['C7'] = p.ville;
        var r = ecrireCellules(paTxt, aEcrire);
        rapport.params_ignores = r.ignorees;
        modifiees[etat.cheminParams] = texteVersU8(r.xml);
      }
      /* --- 7. neutraliser Power Query ---------------------------------- */
      marquerRetiree('xl/connections.xml');
      marquerRetiree('xl/calcChain.xml');
      Object.keys(zip.entrees).forEach(function (nom) {
        if (/^xl\/queryTables\//.test(nom)) marquerRetiree(nom);
        if (/^customXml\//.test(nom)) marquerRetiree(nom);
      });
      /* la table liée à la requête (tableType="queryTable") part avec elle */
      var tables = Object.keys(zip.entrees).filter(function (n) { return /^xl\/tables\/table\d+\.xml$/.test(n); });
      return Promise.all(tables.map(function (n) {
        return lire(zip, n).then(function (t) {
          if (t && t.indexOf('tableType="queryTable"') >= 0) {
            marquerRetiree(n);
            marquerRetiree(n.replace(/\/([^\/]+)$/, '/_rels/$1.rels'));
          }
        });
      }));
    }).then(function () {
      /* --- 5 et 6. noms définis, recalcul forcé ------------------------ */
      var wb = etat.wb, n = donnees.lignes.length + 1;
      wb = wb.replace(/<definedName name="(Tx_[A-Za-z]+)">([^<]*)<\/definedName>/g, function (tout, nom, ref) {
        var m = /^(.*!\$[A-Z]+\$)(\d+)(:\$[A-Z]+\$)(\d+)$/.exec(ref);
        if (!m) return tout;
        var fin = Math.max(n, +m[2]);
        return '<definedName name="' + nom + '">' + m[1] + m[2] + m[3] + fin + '</definedName>';
      });
      wb = wb.replace(/<definedName [^>]*localSheetId="[^"]*"[^>]*>[^<]*<\/definedName>/g, function (t) {
        return /DonnéesExternes|ExternalData/i.test(t) ? '' : t;
      });
      if (/<calcPr[^>]*\/>/.test(wb)) {
        wb = wb.replace(/<calcPr([^>]*)\/>/, function (tout, attrs) {
          attrs = attrs.replace(/\sfullCalcOnLoad="[^"]*"/, '');
          return '<calcPr' + attrs + ' fullCalcOnLoad="1"/>';
        });
      } else {
        wb = wb.replace('</workbook>', '<calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>');
      }
      modifiees['xl/workbook.xml'] = texteVersU8(wb);

      /* relations du classeur : retirer celles qui pointent vers du retiré */
      var rels = etat.rels.replace(/<Relationship\b[^>]*\/>/g, function (t) {
        var m = /Target="([^"]+)"/.exec(t); if (!m) return t;
        var cible = 'xl/' + m[1].replace(/^\/?xl\//, '');
        if (m[1].indexOf('../') === 0) cible = m[1].replace('../', '');
        return retirees[cible] ? '' : t;
      });
      modifiees['xl/_rels/workbook.xml.rels'] = texteVersU8(rels);

      return lire(zip, '[Content_Types].xml');
    }).then(function (ct) {
      var neuf = ct.replace(/<Override\b[^>]*\/>/g, function (t) {
        var m = /PartName="\/([^"]+)"/.exec(t);
        return (m && retirees[m[1]]) ? '' : t;
      });
      modifiees['[Content_Types].xml'] = texteVersU8(neuf);

      /* --- 8. recompression ------------------------------------------- */
      var parties = [];
      zip.ordre.forEach(function (nom) {
        if (retirees[nom]) return;
        if (modifiees[nom]) { parties.push({ nom: nom, u8: modifiees[nom] }); return; }
        var e = zip.entrees[nom];
        parties.push({ nom: nom, brut: octetsComprimes(zip, nom), methode: e.methode, crc: e.crc, brute: e.brute });
      });
      return ecrireZip(parties);
    }).then(function (octets) {
      return { octets: octets, rapport: rapport };
    });
  }

  var api = {
    ouvrirZip: ouvrirZip, lire: lire, lireOctets: lireOctets, ecrireZip: ecrireZip, crc32: crc32,
    analyser: analyser, greffer: greffer, serieVersDate: serieVersDate, dateVersSerie: dateVersSerie,
    ecrireCellules: ecrireCellules, refDecoupe: refDecoupe
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.Classeur = api;
})(typeof self !== 'undefined' ? self : this);
