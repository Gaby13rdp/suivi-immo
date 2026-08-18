/* ============================================================================
   engine.js — moteur de calcul de l'application.
   Reproduit à l'identique les formules du Dashboard Excel
   (SUMIFS sur Tx_*, table T_Categories, paramètres nommés).
   Aucune dépendance. Utilisable en navigateur et en Node (tests).
   ========================================================================== */
(function (root) {
  'use strict';

  var T = { DATE: 0, MONTANT: 1, NATURE: 2, CATFIN: 3, STUDIO: 4, TYPE: 5, EXCLURE: 6, SOURCE: 7 };

  function r2(x) { return Math.round((x + Number.EPSILON) * 100) / 100; }
  function iso(d) {            // date locale (pas UTC) au format AAAA-MM-JJ
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function monthKey(s) { return s.slice(0, 7); }
  function addMonths(ym, n) {
    var y = +ym.slice(0, 4), m = +ym.slice(5, 7) - 1 + n;
    y += Math.floor(m / 12); m = ((m % 12) + 12) % 12;
    return y + '-' + String(m + 1).padStart(2, '0');
  }

  /* ---- somme conditionnelle (équivalent SUMIFS) --------------------------- */
  function sum(rows, pred) {
    var s = 0;
    for (var i = 0; i < rows.length; i++) if (pred(rows[i])) s += rows[i][T.MONTANT];
    return s;
  }
  function count(rows, pred) {
    var n = 0;
    for (var i = 0; i < rows.length; i++) if (pred(rows[i])) n++;
    return n;
  }
  var actif = function (r) { return r[T.EXCLURE] !== 1; };

  /* ======================================================================== */
  function compute(data, filters, today) {
    filters = filters || {};
    var annee = filters.annee || 'Toutes';
    var studio = filters.studio || 'Tous';
    var perimetre = filters.perimetre || 'Toutes les dépenses';
    today = today || new Date();

    var tx = data.tx, p = data.params, cats = data.cats;
    var nb = Math.max(1, p.nb_studios || 1);

    /* ---- 1. INVESTISSEMENT ------------------------------------------- */
    var C12 = p.prix_achat;
    var C13 = -sum(tx, function (r) { return actif(r) && r[T.NATURE] === 'Notaire'; }) + p.frais_acte_hors_releve;
    var C14 = -sum(tx, function (r) { return actif(r) && r[T.NATURE] === 'Travaux'; });
    var C15 = -sum(tx, function (r) { return actif(r) && r[T.NATURE] === 'Ameublement'; });
    var C16 = r2(-sum(tx, function (r) { return actif(r) && r[T.CATFIN] === 'Acquisition'; })
      - (C13 - p.frais_acte_hors_releve) - C14 - C15);
    var C17 = C12 + C13 + C14 + C15 + C16;
    var C18 = -sum(tx, function (r) { return actif(r) && r[T.NATURE] === 'Frais de garantie'; })
      - sum(tx, function (r) { return actif(r) && r[T.NATURE] === 'Frais bancaires'; });
    var C19 = C17 + C18;

    /* ---- 2. RECETTES -------------------------------------------------- */
    var F12 = sum(tx, function (r) { return actif(r) && r[T.NATURE] === 'Loyers'; });
    var F13 = sum(tx, function (r) { return actif(r) && r[T.NATURE] === 'Remboursements et avoirs'; });
    var F15 = sum(tx, function (r) { return actif(r) && r[T.CATFIN] === 'Recettes'; });
    var F14 = F15 - F12 - F13;
    var F16 = sum(tx, function (r) { return actif(r) && r[T.NATURE] === 'Déblocage prêt'; });
    var F18 = (p.budget_travaux > 0) ? C14 / p.budget_travaux : null;

    /* ---- 3. COÛTS RÉELS ----------------------------------------------- */
    var C22 = -sum(tx, function (r) { return actif(r) && r[T.CATFIN] === 'Exploitation'; });
    var C23 = -sum(tx, function (r) { return actif(r) && r[T.NATURE] === 'Intérêts'; });
    var C24 = -sum(tx, function (r) { return actif(r) && r[T.NATURE] === 'Assurance emprunteur'; });
    var C25 = C18;
    var C26 = C22 + C23 + C24 + C25;

    /* ---- 4. FINANCEMENT ------------------------------------------------ */
    var F22 = p.deblocage_hors_compte + F16;                 // Capital_Debloque
    var F23 = Math.max(0, p.emprunt_total - F22);
    var F24 = -sum(tx, function (r) { return actif(r) && r[T.NATURE] === 'Capital remboursé'; });
    var F25 = F22 - F24;
    var F27 = (p.emprunt_total > 0 && p.mensualite_hors_assurance > 0)
      ? (p.mensualite_hors_assurance + p.assurance_mensuelle) * F22 / p.emprunt_total : null;
    var F28 = (F27 !== null && p.nb_studios > 0) ? F27 / p.nb_studios : null;

    /* ---- 5. RÉSULTAT --------------------------------------------------- */
    var C30 = F15 - C22;
    var C31 = C30 - C23 - C24 - C25;
    var C32 = sum(tx, actif) - sum(tx, function (r) { return actif(r) && r[T.TYPE] === 'Transfert interne'; });
    var C33 = Math.max(0, -C32);
    // Duree_Ecoulee = MAX(1/12 ; (AUJOURDHUI - date d'acquisition) / 365,25)
    var duree = 1;
    if (p.date_acquisition) {
      var days = (new Date(iso(today) + 'T00:00:00Z') - new Date(p.date_acquisition + 'T00:00:00Z')) / 86400000;
      duree = Math.max(1 / 12, days / 365.25);
    }
    var C34 = (F12 > 0 && C17 > 0) ? (C30 / duree) / C17 : null;
    var C35 = (F12 > 0 && C17 > 0) ? (F12 / duree) / C17 : null;

    /* ---- 6. RÉCONCILIATION --------------------------------------------- */
    // Le classeur calcule les emplois comme « coût de revient + charges ». Dès que
    // le différé se termine, le capital remboursé sort de la trésorerie sans figurer
    // dans ces deux postes : l'application l'ajoute pour que l'écart reste nul,
    // et conserve la version du classeur pour le contrôle de cohérence.
    var L13 = C19, L14 = C22 + C23 + C24;
    var L15xl = L13 + L14;
    var L15 = L15xl + F24;
    var L17 = F22, L18 = F15, L19 = C33, L20 = L17 + L18 + L19;
    var L21 = r2(L15 - L20);
    var L21xl = r2(L15xl - L20);

    /* ---- ALERTES -------------------------------------------------------- */
    var nCateg = count(tx, function (r) { return actif(r) && r[T.NATURE] === 'À catégoriser'; });
    var mCateg = -sum(tx, function (r) { return actif(r) && r[T.NATURE] === 'À catégoriser'; });
    var nAttente = count(tx, function (r) { return r[T.SOURCE] === 'En attente'; });
    var mAttente = -sum(tx, function (r) { return r[T.SOURCE] === 'En attente'; });
    var nDoublons = count(tx, function (r) { return r[T.EXCLURE] === 1 && r[T.SOURCE] !== 'En attente'; });
    var nSaisies = count(tx, function (r) { return r[T.SOURCE] === 'Saisie manuelle'; });
    var differeFini = p.date_fin_differe ? (iso(today) > p.date_fin_differe) : null;

    var alertes = [];
    alertes.push(nCateg === 0
      ? { etat: 'good', texte: 'Toutes les transactions sont catégorisées.' }
      : { etat: 'warning', texte: nCateg + ' transaction(s) à catégoriser pour ' + fmtEur(mCateg) + '.', detail: 'Onglet Transactions → filtrez « À catégoriser », puis ajoutez un mot-clé dans Paramètres.' });
    alertes.push(nAttente === 0
      ? { etat: 'good', texte: 'Aucune ligne en attente.' }
      : { etat: 'warning', texte: nAttente + ' ligne(s) en attente pour ' + fmtEur(mAttente) + '.', detail: 'Pas encore constatées sur le compte : exclues de tous les calculs.' });
    alertes.push(nDoublons === 0
      ? { etat: 'good', texte: 'Aucun doublon neutralisé.' }
      : { etat: 'info', texte: nDoublons + ' opération(s) neutralisée(s).', detail: 'Même paiement présent dans l’historique et sur les relevés : motif dans Paramètres, section 6.' });
    if (differeFini === null) {
      alertes.push({ etat: 'info', texte: 'Différé non renseigné.', detail: 'Complétez la durée du différé dans Paramètres.' });
    } else if (differeFini) {
      alertes.push({ etat: 'warning', texte: 'Différé d’amortissement terminé depuis le ' + fmtDate(p.date_fin_differe) + '.', detail: 'Vérifiez la ventilation capital / intérêts des échéances.' });
    } else {
      alertes.push({ etat: 'info', texte: 'Différé d’amortissement en cours jusqu’au ' + fmtDate(p.date_fin_differe) + '.', detail: 'Capital remboursé = 0 € : seuls les intérêts et l’assurance sont prélevés.' });
    }
    alertes.push(nSaisies === 0
      ? { etat: 'info', texte: 'Aucune saisie manuelle.', detail: 'Paramètres, section 7, puis Données → Actualiser tout.' }
      : { etat: 'good', texte: nSaisies + ' saisie(s) manuelle(s) reprise(s) dans les calculs.' });

    /* ---- ÉVOLUTION MENSUELLE (non filtrée, comme dans Excel) ------------ */
    var mois = [], first = null, last = null;
    for (var i = 0; i < tx.length; i++) {
      var d = tx[i][T.DATE];
      if (!d || tx[i][T.EXCLURE] === 1) continue;
      var k = monthKey(d);
      if (first === null || k < first) first = k;
      if (last === null || k > last) last = k;
    }
    if (first) {
      var courant = iso(today).slice(0, 7);
      if (courant > last) last = courant;
      var cumul = 0;
      for (var k2 = first; k2 <= last; k2 = addMonths(k2, 1)) {
        (function (km) {
          var inM = function (r) { return actif(r) && r[T.DATE] && monthKey(r[T.DATE]) === km; };
          var rec = sum(tx, function (r) { return inM(r) && r[T.CATFIN] === 'Recettes'; });
          var dep = -sum(tx, function (r) { return inM(r) && r[T.TYPE] === 'Dépense'; });
          var flux = sum(tx, inM) - sum(tx, function (r) { return inM(r) && r[T.TYPE] === 'Transfert interne'; });
          cumul += flux;
          mois.push({ mois: km, recettes: rec, depenses: dep, resultat: rec - dep, cumul: cumul });
        })(k2);
        if (mois.length > 480) break;
      }
    }

    /* ---- DÉTAIL PAR NATURE + TOP 10 (filtrés) ---------------------------- */
    var y2 = (annee === 'Toutes') ? '1900-01-01' : (annee + '-01-01');
    var y3 = (annee === 'Toutes') ? '2999-12-31' : (annee + '-12-31');
    var y4 = (studio === 'Tous') ? '*' : studio;
    var y5 = (String(studio).slice(0, 6) === 'Studio') ? nb : 0;
    var recurrentSeul = (perimetre === 'Charges récurrentes');

    var detail = [], top = [];
    for (var c = 0; c < cats.length; c++) {
      var nature = cats[c][0], catfin = cats[c][1], type = cats[c][2], recur = cats[c][3];
      var dansPeriode = function (r) {
        return actif(r) && r[T.NATURE] === nature && r[T.DATE] && r[T.DATE] >= y2 && r[T.DATE] <= y3;
      };
      var montant = sum(tx, function (r) { return dansPeriode(r) && (y4 === '*' ? r[T.STUDIO] !== '' : r[T.STUDIO] === y4); });
      if (y5 !== 0) {
        montant += sum(tx, function (r) { return dansPeriode(r) && r[T.STUDIO] === 'Réparti'; }) / y5;
      }
      detail.push({ nature: nature, catfin: catfin, type: type, recurrent: recur, montant: montant });
      var z = 0;
      if (type === 'Dépense' && !(recurrentSeul && recur === 'NON')) z = -Math.min(0, montant);
      top.push({ nature: nature, montant: z, rang: c });
    }
    var top10 = top.filter(function (t) { return t.montant > 0; })
      .sort(function (a, b) { return (b.montant - a.montant) || (b.rang - a.rang); })
      .slice(0, 10);

    /* ---- ANALYSE PAR STUDIO (toutes périodes, comme dans Excel) --------- */
    var studios = [];
    var listeStudios = [];
    for (var s = 1; s <= p.nb_studios; s++) listeStudios.push('Studio ' + s);
    listeStudios.push('Commun', 'Non déterminé');
    var repRec = sum(tx, function (r) { return actif(r) && r[T.STUDIO] === 'Réparti' && r[T.CATFIN] === 'Recettes'; });
    var repDep = -sum(tx, function (r) { return actif(r) && r[T.STUDIO] === 'Réparti' && r[T.TYPE] === 'Dépense'; });
    listeStudios.forEach(function (nom) {
      var estStudio = nom.slice(0, 6) === 'Studio';
      var rec = sum(tx, function (r) { return actif(r) && r[T.STUDIO] === nom && r[T.CATFIN] === 'Recettes'; })
        + (estStudio ? repRec / nb : 0);
      var dep = -sum(tx, function (r) { return actif(r) && r[T.STUDIO] === nom && r[T.TYPE] === 'Dépense'; })
        + (estStudio ? repDep / nb : 0);
      studios.push({ nom: nom, recettes: rec, depenses: dep, resultat: rec - dep });
    });

    return {
      invest: { prix: C12, frais: C13, travaux: C14, ameublement: C15, autres: C16, total: C17, financement: C18, revient: C19 },
      recettes: { loyers: F12, remboursements: F13, autres: F14, total: F15, deblocages: F16, avancement: F18 },
      couts: { exploitation: C22, interets: C23, assurance: C24, financiers: C25, total: C26 },
      financement: {
        debloque: F22, reste: F23, rembourse: F24, dette: F25, apport: C33,
        mensualite: F27, loyerEquilibre: F28, coutCredit: p.cout_credit_total,
        emprunt: p.emprunt_total, dateFinDiffere: p.date_fin_differe, differeFini: differeFini
      },
      resultat: { exploitation: C30, courant: C31, cashflow: C32, apport: C33, rendementNet: C34, rendementBrut: C35, duree: duree },
      recon: {
        emplois: L15, emploisClasseur: L15xl, coutRevient: L13, charges: L14, capitalRembourse: F24,
        ressources: L20, deblocage: L17, recettes: L18, apport: L19,
        ecart: L21, ecartClasseur: L21xl, coutCredit: p.cout_credit_total
      },
      alertes: alertes,
      compteurs: { operations: tx.length, aCategoriser: nCateg, enAttente: nAttente, doublons: nDoublons, saisies: nSaisies },
      mensuel: mois,
      detail: detail,
      top10: top10,
      studios: studios,
      filtres: { annee: annee, studio: studio, perimetre: perimetre }
    };
  }

  /* ---- formatage ---------------------------------------------------------- */
  function fmtEur(v, decimales) {
    if (v === null || v === undefined || isNaN(v)) return 'n/a';
    var d = (decimales === undefined) ? 2 : decimales;
    if (Math.abs(v) < Math.pow(10, -d) / 2) v = 0;   // évite « -0,00 € »
    return v.toLocaleString('fr-FR', { minimumFractionDigits: d, maximumFractionDigits: d }) + ' €';
  }
  function fmtDate(s) {
    if (!s) return '';
    var p = s.split('-');
    return p[2] + '/' + p[1] + '/' + p[0];
  }

  var api = { compute: compute, fmtEur: fmtEur, fmtDate: fmtDate, r2: r2, addMonths: addMonths, COLS: T };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.Moteur = api;
})(typeof self !== 'undefined' ? self : this);
