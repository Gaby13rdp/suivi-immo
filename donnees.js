/* ============================================================================
   donnees.js — modèle de données v3 (B14, B15, B16, B18).
   Trois couches strictement séparées :
       livre      immuable, alimenté par l'ingestion
       decisions  modifiable, saisi par l'utilisateur, indexé par id
       (attentes  étape 5, pas encore ici)
   `tx` n'est plus une donnée : c'est une PROJECTION calculée à la volée, au
   format à 8 champs figé de engine.js, plus le champ `bien` en 9ᵉ position.
   Utilisable en navigateur et en Node. Aucune dépendance.
   ========================================================================== */
(function (root) {
  'use strict';

  /* ==========================================================================
     1. EMPREINTE — SHA-256 synchrone et portable (Node ET navigateur).
     WebCrypto est asynchrone ; l'identifiant doit pouvoir être calculé au
     milieu d'une boucle de projection, donc on implémente SHA-256 ici.
     ========================================================================== */
  var K = [
    0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
    0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
    0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
    0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
    0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
    0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
    0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
    0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];

  function sha256hex(texte) {
    var msg = unescape(encodeURIComponent(texte));
    var l = msg.length, n = ((l + 8) >> 6) + 1, m = new Array(n * 16), i;
    for (i = 0; i < n * 16; i++) m[i] = 0;
    for (i = 0; i < l; i++) m[i >> 2] |= msg.charCodeAt(i) << (24 - (i % 4) * 8);
    m[l >> 2] |= 0x80 << (24 - (l % 4) * 8);
    m[n * 16 - 1] = l * 8;
    var H = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
    var w = new Array(64), a, b, c, d, e, f, g, h, t1, t2, j, k;
    function rr(x, s) { return (x >>> s) | (x << (32 - s)); }
    for (j = 0; j < n; j++) {
      for (i = 0; i < 16; i++) w[i] = m[j * 16 + i] | 0;
      for (i = 16; i < 64; i++) {
        var s0 = rr(w[i-15],7) ^ rr(w[i-15],18) ^ (w[i-15] >>> 3);
        var s1 = rr(w[i-2],17) ^ rr(w[i-2],19) ^ (w[i-2] >>> 10);
        w[i] = (w[i-16] + s0 + w[i-7] + s1) | 0;
      }
      a=H[0];b=H[1];c=H[2];d=H[3];e=H[4];f=H[5];g=H[6];h=H[7];
      for (i = 0; i < 64; i++) {
        t1 = (h + (rr(e,6)^rr(e,11)^rr(e,25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) | 0;
        t2 = ((rr(a,2)^rr(a,13)^rr(a,22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
        h=g;g=f;f=e;e=(d+t1)|0;d=c;c=b;b=a;a=(t1+t2)|0;
      }
      H[0]=(H[0]+a)|0;H[1]=(H[1]+b)|0;H[2]=(H[2]+c)|0;H[3]=(H[3]+d)|0;
      H[4]=(H[4]+e)|0;H[5]=(H[5]+f)|0;H[6]=(H[6]+g)|0;H[7]=(H[7]+h)|0;
    }
    var out = '';
    for (k = 0; k < 8; k++) out += ('00000000' + (H[k] >>> 0).toString(16)).slice(-8);
    return out;
  }

  /* Le libellé brut entre dans l'empreinte : il faut le normaliser, sinon un
     changement cosmétique côté banque créerait des doublons (B14). */
  function normaliserLibelle(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/[\u202f\u00a0]/g, ' ').replace(/\s+/g, ' ').trim().toUpperCase();
  }
  function montantCle(m) { return (Math.round((Number(m) || 0) * 100) / 100).toFixed(2); }

  function empreinte(date, montant, libelle, compte) {
    return 'h-' + sha256hex([String(date || ''), montantCle(montant),
      normaliserLibelle(libelle), String(compte || '')].join('\u001f')).slice(0, 20);
  }

  /* Identifiant opaque des saisies manuelles : attribué UNE FOIS à la création,
     jamais recalculé (B14). Corriger le montant ne l'orpheline donc pas. */
  var compteurManuel = 0;
  function idManuel(horodatage, alea) {
    var t = (horodatage === undefined ? Date.now() : horodatage);
    var a = (alea === undefined ? Math.floor(Math.random() * 1679616) : alea);
    compteurManuel = (compteurManuel + 1) % 1296;
    return 'm-' + t.toString(36) + '-' + ('00000' + a.toString(36)).slice(-4) +
           ('00' + compteurManuel.toString(36)).slice(-2);
  }

  var PROVENANCES_EMPREINTE = { 'banque': 1, 'import-xlsx': 1, 'historique': 1 };

  /* Attribue les identifiants d'un lot de lignes ingérées. Deux lignes
     rigoureusement identiques le même jour sont légitimes : l'empreinte reçoit
     alors un rang d'occurrence, ce qui reste déterministe et idempotent. */
  function attribuerIds(lignes) {
    var vus = {};
    return lignes.map(function (l) {
      if (l.id) return l;
      if (!PROVENANCES_EMPREINTE[l.provenance]) { l.id = idManuel(); return l; }
      var base = empreinte(l.date, l.montant, l.libelle, l.compte);
      vus[base] = (vus[base] || 0) + 1;
      l.id = vus[base] > 1 ? base + '-' + vus[base] : base;
      return l;
    });
  }

  /* ==========================================================================
     2. PROJECTION — livre + décisions + table des catégories → `tx`
     ORDRE DES 8 CHAMPS FIGÉ, `bien` en 9ᵉ position, jamais au milieu (B15).
     ========================================================================== */
  var CHAMPS = { DATE: 0, MONTANT: 1, NATURE: 2, CATFIN: 3, STUDIO: 4, TYPE: 5, EXCLURE: 6, SOURCE: 7, BIEN: 8 };

  function tableCats(cats) {
    var m = {};
    (cats || []).forEach(function (c) { if (c && c[0]) m[c[0]] = [c[1] || '', c[2] || '']; });
    return m;
  }
  function projeter(livre, decisions, cats, bien) {
    var m = tableCats(cats), out = [];
    (livre || []).forEach(function (l) {
      if (bien && l.bien !== bien) return;
      if (l.neutralisee) return;                 // saisie manuelle fusionnée (B16)
      var d = (decisions && decisions[l.id]) || {};
      var nature = d.nature || l.nature || 'À catégoriser';
      var cf = m[nature] || ['À catégoriser', 'À catégoriser'];
      out.push([l.date || null, Math.round((Number(l.montant) || 0) * 100) / 100,
        nature, cf[0], d.studio || l.studio || 'Commun', cf[1],
        d.exclure ? 1 : 0, l.source || '', l.bien || 'b1']);
    });
    return out;
  }

  /* ==========================================================================
     3. CONSTRUCTION depuis le classeur (bascule v2 → v3)
     ========================================================================== */
  function depuisClasseur(analyse, bien) {
    bien = bien || 'b1';
    var livre = [], decisions = {}, quand = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
    analyse.tx.forEach(function (t, i) {
      var info = (analyse.lignes && analyse.lignes[i]) || {};
      var source = t[7] || '';
      var provenance = source === 'Relevé bancaire' ? 'banque'
                     : source === 'En attente' ? 'import-xlsx' : 'historique';
      livre.push({ id: null, bien: bien, date: t[0], montant: t[1],
        libelle: info.libelle || '', compte: '', provenance: provenance, source: source });
    });
    attribuerIds(livre);
    livre.forEach(function (l, i) {
      var t = analyse.tx[i];
      decisions[l.id] = { nature: t[2], studio: t[4], exclure: t[6] ? 1 : 0,
        ts: quand, appareil: 'import-xlsx' };
    });
    return { livre: livre, decisions: decisions };
  }

  /* Les lignes prêtes pour la greffe : le classeur exporté reçoit le libellé
     brut et l'identifiant, que le format publié `tx` ne transporte pas. */
  function lignesExport(livre, decisions, cats, bien) {
    var m = tableCats(cats), out = [];
    (livre || []).forEach(function (l) {
      if (bien && l.bien !== bien) return;
      if (l.neutralisee) return;
      var d = (decisions && decisions[l.id]) || {};
      var nature = d.nature || l.nature || 'À catégoriser';
      var cf = m[nature] || ['À catégoriser', 'À catégoriser'];
      out.push({ date: l.date, montant: l.montant, libelle: l.libelle, nature: nature,
        catfin: cf[0], studio: d.studio || l.studio || 'Commun', type: cf[1],
        exclure: d.exclure ? 1 : 0, source: l.source || '', id: l.id });
    });
    out.sort(function (a, b) { return String(a.date || '') < String(b.date || '') ? -1 : String(a.date || '') > String(b.date || '') ? 1 : 0; });
    return out;
  }

  /* ==========================================================================
     4. RÉIMPORT (B18) — écran de différences, jamais de fusion silencieuse
     ========================================================================== */
  function comparerImport(livre, decisions, analyse, bien) {
    bien = bien || 'b1';
    var lu = depuisClasseur(analyse, bien);
    var parId = {}, res = { ajoutees: [], supprimees: [], modifiees: [], inchangees: 0 };
    (livre || []).forEach(function (l) { parId[l.id] = l; });
    var vus = {};
    lu.livre.forEach(function (l, i) {
      vus[l.id] = 1;
      var d = lu.decisions[l.id], a = parId[l.id];
      if (!a) { res.ajoutees.push({ ligne: l, decision: d }); return; }
      var ancienne = (decisions && decisions[l.id]) || {};
      var champs = [];
      ['nature', 'studio'].forEach(function (c) {
        if (String(ancienne[c] || '') !== String(d[c] || '')) champs.push(c);
      });
      if ((ancienne.exclure ? 1 : 0) !== (d.exclure ? 1 : 0)) champs.push('exclure');
      if (champs.length) res.modifiees.push({ id: l.id, ligne: a, avant: ancienne, apres: d, champs: champs });
      else res.inchangees++;
    });
    (livre || []).forEach(function (l) {
      if (l.bien !== bien) return;
      if (!vus[l.id]) res.supprimees.push({ ligne: l, decision: (decisions && decisions[l.id]) || {} });
    });
    return res;
  }

  /* Application EXPLICITE d'un écran de différences. `choix` liste les clés
     retenues ; rien n'est appliqué par défaut (invariant 10). */
  function appliquerImport(livre, decisions, diff, choix) {
    var pris = {}; (choix || []).forEach(function (c) { pris[c] = 1; });
    var nLivre = (livre || []).slice(), nDec = {}, k;
    for (k in decisions) if (Object.prototype.hasOwnProperty.call(decisions, k)) nDec[k] = decisions[k];
    var parId = {}; nLivre.forEach(function (l) { parId[l.id] = 1; });
    diff.ajoutees.forEach(function (a) {
      if (!pris['+' + a.ligne.id] || parId[a.ligne.id]) return;
      nLivre.push(a.ligne); nDec[a.ligne.id] = a.decision; parId[a.ligne.id] = 1;
    });
    diff.modifiees.forEach(function (m) {
      if (!pris['~' + m.id]) return;
      nDec[m.id] = m.apres;
    });
    var retires = {};
    diff.supprimees.forEach(function (s) { if (pris['-' + s.ligne.id]) retires[s.ligne.id] = 1; });
    nLivre = nLivre.filter(function (l) { return !retires[l.id]; });
    return { livre: nLivre, decisions: nDec };
  }

  /* Le fichier réimporté est-il plus ancien que la dernière modification en
     ligne ? On avertit franchement avant de proposer quoi que ce soit (B18). */
  function importPerime(modifieLe, dernierExport) {
    if (!modifieLe || !dernierExport) return false;
    return String(modifieLe) < String(dernierExport);
  }

  /* ==========================================================================
     5. SAISIE MANUELLE ET DOUBLON BANCAIRE (B16)
     ========================================================================== */
  function creerSaisie(champs, bien) {
    return {
      id: idManuel(), bien: bien || 'b1', date: champs.date || null,
      montant: Math.round((Number(champs.montant) || 0) * 100) / 100,
      libelle: champs.libelle || '', compte: '', provenance: 'saisie-manuelle',
      source: 'Saisie manuelle', cree_le: new Date().toISOString().replace(/\.\d+Z$/, 'Z')
    };
  }
  /* Corriger une saisie ne recalcule JAMAIS son identifiant : la décision
     associée survit (B14). */
  function corrigerSaisie(ligne, champs) {
    var n = {}; for (var k in ligne) if (Object.prototype.hasOwnProperty.call(ligne, k)) n[k] = ligne[k];
    if (champs.date !== undefined) n.date = champs.date;
    if (champs.montant !== undefined) n.montant = Math.round((Number(champs.montant) || 0) * 100) / 100;
    if (champs.libelle !== undefined) n.libelle = champs.libelle;
    return n;
  }

  function joursEntre(a, b) {
    if (!a || !b) return 1e9;
    return Math.abs((Date.parse(a + 'T00:00:00Z') - Date.parse(b + 'T00:00:00Z')) / 86400000);
  }
  /* À l'arrivée d'une ligne bancaire : une seule saisie manuelle candidate →
     on PROPOSE la fusion ; plusieurs → on ne fait rien et on signale. */
  function candidatsFusion(livre, ligneBancaire, fenetreJours) {
    var f = fenetreJours === undefined ? 5 : fenetreJours;
    return (livre || []).filter(function (l) {
      return l.provenance === 'saisie-manuelle' && !l.neutralisee && !l.fusionnee_dans &&
        l.bien === ligneBancaire.bien &&
        montantCle(l.montant) === montantCle(ligneBancaire.montant) &&
        joursEntre(l.date, ligneBancaire.date) <= f;
    });
  }
  function propositionFusion(livre, ligneBancaire, fenetreJours) {
    var c = candidatsFusion(livre, ligneBancaire, fenetreJours);
    if (c.length === 1) return { etat: 'proposer', saisie: c[0] };
    if (c.length > 1) return { etat: 'signaler', saisies: c };
    return { etat: 'rien' };
  }
  /* La banque fait foi (A11) : la ligne bancaire devient l'écriture, la saisie
     est NEUTRALISÉE, jamais supprimée, et sa note est conservée. */
  function fusionner(livre, decisions, idBancaire, idSaisie) {
    var nLivre = livre.map(function (l) {
      if (l.id !== idSaisie) return l;
      var n = {}; for (var k in l) if (Object.prototype.hasOwnProperty.call(l, k)) n[k] = l[k];
      n.neutralisee = 1; n.fusionnee_dans = idBancaire;
      return n;
    });
    var nDec = {}, k2;
    for (k2 in decisions) if (Object.prototype.hasOwnProperty.call(decisions, k2)) nDec[k2] = decisions[k2];
    var ds = decisions[idSaisie] || {}, db = nDec[idBancaire] || {};
    nDec[idBancaire] = {
      nature: db.nature || ds.nature, studio: db.studio || ds.studio,
      exclure: db.exclure !== undefined ? db.exclure : (ds.exclure || 0),
      note: db.note || ds.note || '', issue_de: idSaisie,
      ts: new Date().toISOString().replace(/\.\d+Z$/, 'Z'), appareil: db.appareil || 'fusion'
    };
    return { livre: nLivre, decisions: nDec };
  }

  /* L'ingestion ne réécrit que les lignes de provenance `banque` : une saisie
     manuelle ne peut pas être écrasée par une synchronisation (B14). */
  function ingerer(livre, nouvelles) {
    var conserve = (livre || []).filter(function (l) { return l.provenance !== 'banque'; });
    var bancairesExistantes = {}; (livre || []).forEach(function (l) { if (l.provenance === 'banque') bancairesExistantes[l.id] = l; });
    var lot = attribuerIds(nouvelles.map(function (n) {
      var c = {}; for (var k in n) if (Object.prototype.hasOwnProperty.call(n, k)) c[k] = n[k];
      c.provenance = 'banque'; return c;
    }));
    return conserve.concat(lot);
  }

  /* ==========================================================================
     6. ÉCRITURE : file hors ligne et conflit 409 (B16)
     ========================================================================== */
  function fileAjouter(file, action) {
    var f = (file || []).slice();
    f.push({ n: f.length + 1, action: action, le: new Date().toISOString().replace(/\.\d+Z$/, 'Z') });
    return f;
  }
  function appliquerAction(etat, action) {
    var livre = etat.livre, decisions = etat.decisions, k;
    if (action.type === 'decision') {
      var nDec = {}; for (k in decisions) if (Object.prototype.hasOwnProperty.call(decisions, k)) nDec[k] = decisions[k];
      var av = nDec[action.id] || {}, ap = {};
      for (k in av) if (Object.prototype.hasOwnProperty.call(av, k)) ap[k] = av[k];
      for (k in action.champs) if (Object.prototype.hasOwnProperty.call(action.champs, k)) ap[k] = action.champs[k];
      ap.ts = action.le || new Date().toISOString().replace(/\.\d+Z$/, 'Z');
      ap.appareil = action.appareil || 'téléphone';
      nDec[action.id] = ap;
      return { livre: livre, decisions: nDec };
    }
    if (action.type === 'creation') {
      var l = livre.slice();
      if (!l.some(function (x) { return x.id === action.ligne.id; })) l.push(action.ligne);
      var d2 = {}; for (k in decisions) if (Object.prototype.hasOwnProperty.call(decisions, k)) d2[k] = decisions[k];
      if (action.decision) d2[action.ligne.id] = action.decision;
      return { livre: l, decisions: d2 };
    }
    if (action.type === 'fusion') return fusionner(livre, decisions, action.bancaire, action.saisie);
    return etat;
  }
  /* Conflit 409 : on relit, on REJOUE les actions sur la version fraîche, on
     réessaie une fois. On ne force jamais. */
  function rejouer(etatDistant, actions) {
    var e = { livre: etatDistant.livre || [], decisions: etatDistant.decisions || {} };
    (actions || []).forEach(function (a) { e = appliquerAction(e, a.action || a); });
    return e;
  }

  /* ==========================================================================
     7. MULTI-BIENS (B15) — on stocke en multi, on calcule en mono.
     Ce qui se somme : les flux. Ce qui ne se somme pas : les ratios, qui sont
     RECALCULÉS sur les totaux, et le résultat après impôt, jamais consolidé.
     ========================================================================== */
  var SOMMABLES = ['revient', 'apport', 'dette', 'reste', 'cashflow', 'capital_debloque',
    'recettes', 'loyers', 'cout_total'];
  function consolider(resultats) {
    var t = {}, i, k;
    SOMMABLES.forEach(function (c) { t[c] = 0; });
    for (i = 0; i < resultats.length; i++) {
      for (k = 0; k < SOMMABLES.length; k++) {
        var c = SOMMABLES[k];
        t[c] += Number(resultats[i][c]) || 0;
      }
    }
    t.rendement_brut = t.cout_total ? t.loyers / t.cout_total : null;
    t.loyer_equilibre = null;                 // dépend de la mensualité : recalcul par bien
    t.resultat_apres_impot = null;            // BIC + IS ne s'additionnent pas
    t.biens = resultats.length;
    return t;
  }

  var api = {
    sha256hex: sha256hex, empreinte: empreinte, normaliserLibelle: normaliserLibelle,
    idManuel: idManuel, attribuerIds: attribuerIds, CHAMPS: CHAMPS,
    projeter: projeter, depuisClasseur: depuisClasseur, lignesExport: lignesExport,
    comparerImport: comparerImport, appliquerImport: appliquerImport, importPerime: importPerime,
    creerSaisie: creerSaisie, corrigerSaisie: corrigerSaisie,
    candidatsFusion: candidatsFusion, propositionFusion: propositionFusion, fusionner: fusionner,
    ingerer: ingerer, fileAjouter: fileAjouter, appliquerAction: appliquerAction, rejouer: rejouer,
    consolider: consolider
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.Donnees = api;
})(typeof self !== 'undefined' ? self : this);
