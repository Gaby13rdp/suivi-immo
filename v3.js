/* ============================================================================
   v3.js — la partie « outil » de l'application : export du classeur (B17),
   réimport avec écran de différences (B18), saisie depuis le téléphone (B16).
   Chargé par index.html, qui lui passe un contexte minimal (jamais le mot de
   passe). Tout ce qui est calcul de modèle est dans donnees.js, tout ce qui
   touche au fichier .xlsx est dans xlsx.js.
   ========================================================================== */
(function (root) {
  'use strict';

  var CLE_ETAT = 'immo.v3.etat', CLE_JETON = 'immo.v3.jeton';
  var etat = null;        // {livre, decisions, file, dernier_export}
  var ctx = null, dataRef = null, diffEnCours = null, message = '';

  /* Ne jamais réafficher après un verrouillage : une réponse réseau tardive
     (export, envoi) ne doit pas remettre les chiffres à l'écran. */
  function redessiner() { if (ctx && ctx.donnees() === dataRef) ctx.rendre(); }

  function el(tag, attrs, html) {
    var e = document.createElement(tag);
    if (attrs) for (var k in attrs) e.setAttribute(k, attrs[k]);
    if (html !== undefined) e.innerHTML = html;
    return e;
  }
  function esc(s) { return String(s === null || s === undefined ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function eur(v) { return window.Moteur.fmtEur(v); }

  /* ---------- coffre local : rien en clair sur le téléphone (B4) --------- */
  function chiffrerLocal(cle, objet) {
    var iv = crypto.getRandomValues(new Uint8Array(12));
    return crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv }, cle,
      new TextEncoder().encode(JSON.stringify(objet)))
      .then(function (buf) { return { iv: ctx.u8b64(iv), charge: ctx.u8b64(new Uint8Array(buf)) }; });
  }
  function dechiffrerLocal(cle, env) {
    return crypto.subtle.decrypt({ name: 'AES-GCM', iv: ctx.b64u8(env.iv) }, cle, ctx.b64u8(env.charge))
      .then(function (buf) { return JSON.parse(new TextDecoder().decode(buf)); });
  }
  function ecrireLocal(clef, objet) {
    return ctx.cle().then(function (cle) {
      if (!cle) return null;
      return chiffrerLocal(cle, objet).then(function (env) {
        try { localStorage.setItem(clef, JSON.stringify(env)); } catch (e) { }
      });
    });
  }
  function lireLocal(clef) {
    var env = null;
    try { env = JSON.parse(localStorage.getItem(clef) || 'null'); } catch (e) { }
    if (!env) return Promise.resolve(null);
    return ctx.cle().then(function (cle) {
      if (!cle) return null;
      return dechiffrerLocal(cle, env).catch(function () { return null; });
    });
  }

  /* ---------- état v3 : bascule v2 → v3 au premier déverrouillage -------- */
  function construireEtat(data) {
    var D = window.Donnees;
    var analyse = { tx: data.tx || [], lignes: (data.libelles || []).map(function (l) { return { libelle: l }; }) };
    var m = D.depuisClasseur(analyse, 'b1');
    return { livre: m.livre, decisions: m.decisions, file: [], dernier_export: null, publie: data.generated_at || null };
  }
  function sauverEtat() { return ecrireLocal(CLE_ETAT, etat); }

  /* ---------- projection : `tx` recalculé, jamais stocké ---------------- */
  function assurerProjection() {
    var t = window.Donnees.projeter(etat.livre, etat.decisions, dataRef.cats, 'b1');
    var court = function (r) { return JSON.stringify(r.map(function (x) { return x.slice(0, 8); })); };
    if (court(t) === court(dataRef.tx || [])) { dataRef.tx = t; return false; }
    dataRef.tx = t;
    return true;
  }
  function rejouerProjection() {
    assurerProjection();
    ctx.majDonnees(dataRef);
  }

  /* ======================================================================
     1. EXPORT XLSX (B17) — toujours en mode réalisé (invariant 16)
     ====================================================================== */
  function urlsGabarit() {
    var u = ['./gabarit.json'];
    if (dataRef && dataRef.repo) u.push('https://raw.githubusercontent.com/' + dataRef.repo + '/main/gabarit.json');
    return u;
  }
  function chargerGabarit() {
    var urls = urlsGabarit(), i = 0;
    function suivant() {
      if (i >= urls.length) return Promise.reject(new Error('gabarit introuvable'));
      return fetch(urls[i++], { cache: 'no-store' })
        .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error('http ' + r.status)); })
        .catch(suivant);
    }
    return suivant().then(function (env) {
      return ctx.cle().then(function (cle) {
        if (!cle) throw new Error('coffre verrouillé');
        return crypto.subtle.decrypt({ name: 'AES-GCM', iv: ctx.b64u8(env.iv) }, cle, ctx.b64u8(env.charge));
      });
    });
  }
  function exporter(bouton) {
    bouton.disabled = true; bouton.textContent = 'Préparation…';
    return chargerGabarit().then(function (buf) {
      var D = window.Donnees;
      var lignes = D.lignesExport(etat.livre, etat.decisions, dataRef.cats, 'b1');
      return window.Classeur.greffer(buf, { params: dataRef.params, lignes: lignes });
    }).then(function (res) {
      var nom = 'Suivi-' + new Date().toISOString().slice(0, 10) + '.xlsx';
      var url = URL.createObjectURL(new Blob([res.octets],
        { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
      var a = document.createElement('a'); a.href = url; a.download = nom;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 30000);
      etat.dernier_export = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
      message = res.rapport.lignes + ' opérations exportées' +
        (res.rapport.params_ignores.length
          ? ' — ' + res.rapport.params_ignores.length + ' cellules de paramètres laissées à leur formule'
          : '') + '.';
      return sauverEtat();
    }).catch(function (e) {
      message = 'Export impossible : ' + e.message + '. Le gabarit doit avoir été publié depuis le PC.';
    }).then(function () {
      bouton.disabled = false; bouton.textContent = 'Exporter le classeur (.xlsx)';
      redessiner();
    });
  }

  /* ======================================================================
     2. RÉIMPORT (B18) — écran de différences, validation explicite
     ====================================================================== */
  function reimporter(fichier) {
    message = 'Lecture du classeur…'; redessiner();
    return fichier.arrayBuffer().then(function (buf) {
      return window.Classeur.analyser(buf, fichier.name,
        new Date(fichier.lastModified).toISOString().replace(/\.\d+Z$/, 'Z'));
    }).then(function (analyse) {
      var D = window.Donnees;
      diffEnCours = D.comparerImport(etat.livre, etat.decisions, analyse, 'b1');
      diffEnCours.analyse = analyse;
      diffEnCours.perime = D.importPerime(analyse.workbook.modified, etat.dernier_export);
      message = '';
      redessiner();
    }).catch(function (e) {
      message = 'Classeur illisible : ' + e.message;
      redessiner();
    });
  }
  function validerDiff(racine) {
    var choix = [];
    Array.prototype.slice.call(racine.querySelectorAll('input[data-diff]')).forEach(function (c) {
      if (c.checked) choix.push(c.getAttribute('data-diff'));
    });
    var r = window.Donnees.appliquerImport(etat.livre, etat.decisions, diffEnCours, choix);
    etat.livre = r.livre; etat.decisions = r.decisions;
    if (diffEnCours.analyse && diffEnCours.analyse.params) dataRef.params = diffEnCours.analyse.params;
    if (diffEnCours.analyse && diffEnCours.analyse.excel) dataRef.excel = diffEnCours.analyse.excel;
    message = choix.length + ' différences appliquées.';
    diffEnCours = null;
    return sauverEtat().then(function () { rejouerProjection(); });
  }

  /* ======================================================================
     3. SAISIE DEPUIS LE TÉLÉPHONE (B16)
     ====================================================================== */
  function creerOperation(champs) {
    var D = window.Donnees;
    var ligne = D.creerSaisie(champs, 'b1');
    var decision = { nature: champs.nature || 'À catégoriser', studio: champs.studio || 'Commun',
      exclure: 0, note: champs.note || '', ts: ligne.cree_le, appareil: 'téléphone' };
    var action = { type: 'creation', ligne: ligne, decision: decision, le: ligne.cree_le, appareil: 'téléphone' };
    var e = D.appliquerAction({ livre: etat.livre, decisions: etat.decisions }, action);
    etat.livre = e.livre; etat.decisions = e.decisions;
    etat.file = D.fileAjouter(etat.file, action);
    message = 'Opération enregistrée. Elle n’existe pas encore dans le classeur : ' +
      'elle y entrera au prochain export.';
    return sauverEtat().then(function () { rejouerProjection(); });
  }
  function categoriser(id, nature, studio) {
    var D = window.Donnees;
    var action = { type: 'decision', id: id, champs: { nature: nature, studio: studio },
      le: new Date().toISOString().replace(/\.\d+Z$/, 'Z'), appareil: 'téléphone' };
    var e = D.appliquerAction({ livre: etat.livre, decisions: etat.decisions }, action);
    etat.livre = e.livre; etat.decisions = e.decisions;
    etat.file = D.fileAjouter(etat.file, action);
    return sauverEtat().then(function () { rejouerProjection(); });
  }

  /* ======================================================================
     4. ENVOI VERS LE DÉPÔT — sha obligatoire, 409 rejoué une fois, jamais
     forcé (B16, invariant 25). Les décisions prises hors ligne restent dans
     la file et sont rejouées au retour du réseau.
     ====================================================================== */
  function apiDepot(chemin, jeton, options) {
    options = options || {};
    var entetes = { 'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28',
      'Authorization': 'Bearer ' + jeton };
    if (options.body) entetes['Content-Type'] = 'application/json';
    return fetch('https://api.github.com' + chemin, { method: options.method || 'GET',
      headers: entetes, body: options.body ? JSON.stringify(options.body) : undefined });
  }
  function enveloppePubliable(cle, charge, modele) {
    var iv = crypto.getRandomValues(new Uint8Array(12));
    return crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv }, cle, new TextEncoder().encode(JSON.stringify(charge)))
      .then(function (buf) {
        return { schema: 1, chiffre: 1,
          generated_at: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
          source: 'application', repo: modele.repo || null,
          kdf: modele.kdf, iv: ctx.u8b64(iv), charge: ctx.u8b64(new Uint8Array(buf)) };
      });
  }
  function envoyer(bouton) {
    if (!etat.file.length) return Promise.resolve();
    bouton.disabled = true; bouton.textContent = 'Envoi…';
    var jeton = null, cle = null;
    return lireLocal(CLE_JETON).then(function (j) {
      jeton = j && j.jeton;
      if (!jeton) throw new Error('aucun jeton enregistré');
      if (!dataRef.repo) throw new Error('dépôt inconnu');
      return ctx.cle();
    }).then(function (c) {
      cle = c;
      if (!cle) throw new Error('coffre verrouillé');
      return tenter(1);
    }).then(function () {
      etat.file = [];
      message = 'Modifications envoyées.';
      return sauverEtat();
    }).catch(function (e) {
      message = 'Envoi impossible : ' + e.message + '. Les modifications restent en attente.';
    }).then(function () {
      bouton.disabled = false; redessiner();
    });

    function tenter(essai) {
      return apiDepot('/repos/' + dataRef.repo + '/contents/data.json', jeton).then(function (r) {
        if (!r.ok) throw new Error('lecture du dépôt : ' + r.status);
        return r.json();
      }).then(function (meta) {
        var distant = JSON.parse(decodeURIComponent(escape(atob((meta.content || '').replace(/\n/g, '')))));
        return crypto.subtle.decrypt({ name: 'AES-GCM', iv: ctx.b64u8(distant.iv) }, cle, ctx.b64u8(distant.charge))
          .then(function (buf) { return { meta: meta, env: distant, clair: JSON.parse(new TextDecoder().decode(buf)) }; });
      }).then(function (d) {
        /* on rejoue la file sur la version fraîche : jamais d'écrasement */
        var base = { livre: d.clair.livre || etat.livre, decisions: d.clair.decisions || etat.decisions };
        var fusion = window.Donnees.rejouer(base, etat.file);
        var charge = {};
        for (var k in d.clair) if (Object.prototype.hasOwnProperty.call(d.clair, k)) charge[k] = d.clair[k];
        charge.livre = fusion.livre; charge.decisions = fusion.decisions;
        charge.tx = window.Donnees.projeter(fusion.livre, fusion.decisions, charge.cats, 'b1');
        return enveloppePubliable(cle, charge, { repo: dataRef.repo, kdf: d.env.kdf }).then(function (env) {
          return apiDepot('/repos/' + dataRef.repo + '/contents/data.json', jeton, {
            method: 'PUT',
            body: { message: 'suivi : ' + etat.file.length + ' modification(s) depuis le téléphone',
              content: btoa(unescape(encodeURIComponent(JSON.stringify(env)))), sha: d.meta.sha }
          }).then(function (r) {
            if (r.ok) { etat.livre = fusion.livre; etat.decisions = fusion.decisions; return true; }
            if ((r.status === 409 || r.status === 422) && essai === 1) return tenter(2);
            throw new Error('écriture refusée (' + r.status + ')');
          });
        });
      });
    }
  }

  /* ======================================================================
     5. RENDU
     ====================================================================== */
  function section(app, data, contexte) {
    ctx = contexte; dataRef = data;
    var s = el('section', { id: 'sec-v3' });
    s.appendChild(el('h2', null, 'Classeur et saisie'));
    app.appendChild(s);
    if (!etat) {
      s.appendChild(el('div', { class: 'note' }, 'Préparation du grand-livre…'));
      lireLocal(CLE_ETAT).then(function (e) {
        etat = e || construireEtat(data);
        return sauverEtat();
      }).then(function () { redessiner(); });
      return;
    }
    /* le grand-livre fait foi à l'écran : si la projection diffère de ce qui
       vient d'être affiché, on réaffiche une fois, puis on s'arrête. */
    if (assurerProjection()) {
      setTimeout(function () { redessiner(); }, 0);
      return;
    }
    dessiner(s);
  }

  function dessiner(s) {
    var D = window.Donnees;
    if (message) s.appendChild(el('div', { class: 'note', id: 'v3-msg' }, esc(message)));

    /* --- écart légitime entre la saisie et le classeur (B16) ---------- */
    var manuelles = etat.livre.filter(function (l) { return l.provenance === 'saisie-manuelle' && !l.neutralisee; });
    if (manuelles.length) {
      s.appendChild(el('div', { class: 'note', id: 'v3-ecart' },
        manuelles.length + ' opération(s) saisie(s) ici n’existent pas encore dans le classeur. ' +
        'Le badge de contrôle croisé signalera donc un écart : il est normal, et il disparaîtra ' +
        'au prochain export.'));
    }

    /* --- export ------------------------------------------------------- */
    var bExp = el('button', { id: 'v3-export', class: 'v3-btn' }, 'Exporter le classeur (.xlsx)');
    bExp.onclick = function () { exporter(bExp); };
    s.appendChild(bExp);
    s.appendChild(el('div', { class: 'note' },
      'L’export est toujours produit en mode réalisé, quel que soit l’affichage. ' +
      'Power Query y est neutralisé : le classeur exporté est un instantané figé.' +
      (etat.dernier_export ? ' Dernier export : ' + esc(etat.dernier_export.slice(0, 10)) + '.' : '')));

    /* --- réimport ----------------------------------------------------- */
    var lab = el('label', { class: 'v3-fichier', for: 'v3-fichier' }, 'Réimporter un classeur modifié');
    var inp = el('input', { type: 'file', id: 'v3-fichier', accept: '.xlsx' });
    inp.onchange = function () { if (inp.files[0]) reimporter(inp.files[0]); };
    s.appendChild(lab); s.appendChild(inp);

    if (diffEnCours) s.appendChild(ecranDifferences());

    /* --- saisie ------------------------------------------------------- */
    s.appendChild(el('h3', { class: 'v3-h3' }, 'Nouvelle opération'));
    var f = el('div', { class: 'v3-form', id: 'v3-saisie' });
    var iDate = el('input', { type: 'date', id: 'v3-date' });
    iDate.value = new Date().toISOString().slice(0, 10);
    var iMont = el('input', { type: 'number', id: 'v3-montant', step: '0.01', placeholder: 'montant (négatif = dépense)' });
    var iLib = el('input', { type: 'text', id: 'v3-libelle', placeholder: 'libellé' });
    var sNat = el('select', { id: 'v3-nature' });
    (dataRef.cats || []).forEach(function (c) {
      if (!c[0] || c[0].indexOf('➔') === 0) return;
      sNat.appendChild(el('option', { value: c[0] }, esc(c[0])));
    });
    var sStu = el('select', { id: 'v3-studio' });
    ['Commun', 'Réparti'].concat((function () {
      var t = [], i; for (i = 1; i <= (dataRef.params.nb_studios || 1); i++) t.push('Studio ' + i); return t;
    })()).forEach(function (v) { sStu.appendChild(el('option', { value: v }, v)); });
    var bAdd = el('button', { id: 'v3-creer', class: 'v3-btn' }, 'Enregistrer l’opération');
    bAdd.onclick = function () {
      if (!iMont.value) { message = 'Montant manquant.'; redessiner(); return; }
      creerOperation({ date: iDate.value, montant: parseFloat(iMont.value), libelle: iLib.value,
        nature: sNat.value, studio: sStu.value });
    };
    [iDate, iMont, iLib, sNat, sStu, bAdd].forEach(function (n) { f.appendChild(n); });
    s.appendChild(f);

    /* --- à catégoriser ------------------------------------------------ */
    var aCat = etat.livre.filter(function (l) {
      if (l.neutralisee) return false;
      var d = etat.decisions[l.id] || {};
      return !d.nature || d.nature === 'À catégoriser';
    });
    if (aCat.length) {
      s.appendChild(el('h3', { class: 'v3-h3' }, aCat.length + ' opération(s) à catégoriser'));
      var ul = el('div', { id: 'v3-acat' });
      aCat.slice(0, 12).forEach(function (l) {
        var d = el('div', { class: 'v3-row' });
        d.appendChild(el('span', null, esc((l.date || 'sans date') + ' · ' + eur(l.montant) + ' · ' + (l.libelle || ''))));
        var sel = el('select', { 'data-cat': l.id });
        sel.appendChild(el('option', { value: '' }, '— choisir —'));
        (dataRef.cats || []).forEach(function (c) {
          if (!c[0] || c[0].indexOf('➔') === 0) return;
          sel.appendChild(el('option', { value: c[0] }, esc(c[0])));
        });
        sel.onchange = function () { if (sel.value) categoriser(l.id, sel.value, (etat.decisions[l.id] || {}).studio || 'Commun'); };
        d.appendChild(sel);
        ul.appendChild(d);
      });
      s.appendChild(ul);
    }

    /* --- file d'attente et envoi -------------------------------------- */
    var pied = el('div', { class: 'v3-envoi' });
    pied.appendChild(el('span', { id: 'v3-file' },
      etat.file.length ? etat.file.length + ' modification(s) non envoyée(s)' : 'tout est envoyé'));
    var bEnv = el('button', { id: 'v3-envoyer', class: 'v3-btn' }, 'Envoyer au dépôt');
    bEnv.disabled = !etat.file.length;
    bEnv.onclick = function () { envoyer(bEnv); };
    pied.appendChild(bEnv);
    s.appendChild(pied);

    var det = el('details', { id: 'v3-jeton-bloc' });
    det.appendChild(el('summary', null, 'Jeton d’écriture'));
    var iJet = el('input', { type: 'password', id: 'v3-jeton', placeholder: 'jeton GitHub (Contents: lecture + écriture)' });
    var bJet = el('button', { id: 'v3-jeton-ok', class: 'v3-btn' }, 'Enregistrer le jeton');
    bJet.onclick = function () {
      if (!iJet.value) return;
      ecrireLocal(CLE_JETON, { jeton: iJet.value }).then(function () {
        iJet.value = ''; message = 'Jeton enregistré, chiffré par la clé du coffre.'; redessiner();
      });
    };
    det.appendChild(iJet); det.appendChild(bJet);
    det.appendChild(el('div', { class: 'note' },
      'Le jeton est chiffré avec la clé du coffre : il n’est utilisable qu’une fois l’application déverrouillée.'));
    s.appendChild(det);
  }

  function ecranDifferences() {
    var d = diffEnCours, z = el('div', { id: 'v3-diff', class: 'v3-diff' });
    if (d.perime) z.appendChild(el('div', { class: 'note', id: 'v3-perime' },
      '⚠ Ce fichier est plus ancien que le dernier export. Il ne contient probablement pas ' +
      'les modifications faites depuis. Rien ne sera appliqué sans votre validation.'));
    z.appendChild(el('div', { class: 'note' },
      d.ajoutees.length + ' ajout(s), ' + d.supprimees.length + ' disparition(s), ' +
      d.modifiees.length + ' décision(s) modifiée(s), ' + d.inchangees + ' inchangée(s). ' +
      'Rien n’est appliqué tant que vous n’avez pas validé.'));
    function bloc(titre, liste, prefixe, texte) {
      if (!liste.length) return;
      z.appendChild(el('h3', { class: 'v3-h3' }, titre));
      liste.slice(0, 40).forEach(function (x) {
        var id = (x.ligne || x).id || x.id;
        var r = el('label', { class: 'v3-row' });
        var c = el('input', { type: 'checkbox' });
        c.setAttribute('data-diff', prefixe + id);
        r.appendChild(c);
        r.appendChild(el('span', null, esc(texte(x))));
        z.appendChild(r);
      });
    }
    bloc('Lignes ajoutées par le classeur', d.ajoutees, '+', function (x) {
      return (x.ligne.date || 'sans date') + ' · ' + eur(x.ligne.montant) + ' · ' + (x.ligne.libelle || '');
    });
    bloc('Lignes absentes du classeur', d.supprimees, '-', function (x) {
      return (x.ligne.date || 'sans date') + ' · ' + eur(x.ligne.montant) + ' · ' + (x.ligne.libelle || '');
    });
    bloc('Décisions modifiées', d.modifiees, '~', function (x) {
      return x.champs.map(function (c) {
        return c + ' : ' + (x.avant[c] === undefined ? '—' : x.avant[c]) + ' → ' + x.apres[c];
      }).join(' · ');
    });
    var barre = el('div', { class: 'v3-envoi' });
    var bTout = el('button', { id: 'v3-tout', class: 'v3-btn' }, 'Tout cocher');
    bTout.onclick = function () {
      Array.prototype.slice.call(z.querySelectorAll('input[data-diff]')).forEach(function (c) { c.checked = true; });
    };
    var bVal = el('button', { id: 'v3-valider', class: 'v3-btn' }, 'Valider les différences cochées');
    bVal.onclick = function () { validerDiff(z); };
    var bAnn = el('button', { id: 'v3-annuler', class: 'v3-btn' }, 'Annuler');
    bAnn.onclick = function () { diffEnCours = null; message = 'Réimport abandonné, rien n’a été modifié.'; redessiner(); };
    barre.appendChild(bTout); barre.appendChild(bVal); barre.appendChild(bAnn);
    z.appendChild(barre);
    return z;
  }

  var api = { section: section,
    /* exposés pour le banc de test */
    _etat: function () { return etat; }, _poser: function (e) { etat = e; } };
  root.SuiviV3 = api;
})(typeof self !== 'undefined' ? self : this);
