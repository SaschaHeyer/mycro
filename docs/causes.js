/* Mycro — what contaminated it (I117)
   ==================================================================================
   ONE vocabulary for a contaminant, shared by the Grow Log and the Culture Library.

   Why it is shared. I113 gave the Grow Log a cause on every lost run, with the six
   culprit names lifted verbatim from the identifier on /guides/contamination.html. The
   Culture Library's own contamination flag recorded nothing at all, so the one place a
   contaminant is most often FIRST seen (a cloudy liquid culture, a green plate) could
   not say what it was, and its seeded example carried the answer as prose in a notes
   field ("Cloudy at day 5 — bacterial"). Two tools writing to one document with two
   vocabularies for one mould is the drift I116 had to undo for sample ids; the fix is
   one list, not two lists kept in step.

   Two entries are deliberately NOT diagnoses:
     'other'   — answered, but names nothing anyone could act on.
     'unknown' — not answered. Still a loss, never guessed at.

   ⚠️ Every lookup uses hasOwnProperty. A bare CAUSE[k] is truthy for "constructor"
   (I91, I115, I116), which would let a garbage import render a function as a cause.
   ================================================================================== */
(function (root) {
  'use strict';

  var CAUSE = {
    trich:     'Trichoderma, green mould',
    cobweb:    'Cobweb mould, Dactylium',
    black:     'Black or pin mould, Aspergillus or Rhizopus',
    wetspot:   'Wet spot or sour rot, Bacillus',
    bactyeast: 'A bacterial or yeast contamination',
    blotch:    'Bacterial blotch, Pseudomonas',
    other:     'Something else',
    unknown:   'Not sure'
  };
  var ORDER = ['trich', 'cobweb', 'black', 'wetspot', 'bactyeast', 'blotch', 'other', 'unknown'];

  /* A culture is a plate, a broth or a jar of grain. Bacterial blotch is a disease of the
     mushroom cap, so it is left out of the culture picker. A culture that somehow carries
     it (an import) still reads and exports correctly — only the offer is narrower. */
  var CULTURE_ORDER = ORDER.filter(function (k) { return k !== 'blotch'; });

  function has(k) { return typeof k === 'string' && Object.prototype.hasOwnProperty.call(CAUSE, k); }
  // A record from before causes existed carries none. It reads as 'unknown', never guessed.
  function of(rec) { return (rec && has(rec.cause)) ? rec.cause : 'unknown'; }
  // Does this cause name something a grower could actually change?
  function isNamed(k) { return has(k) && k !== 'other' && k !== 'unknown'; }

  root.MycroCauses = { CAUSE: CAUSE, ORDER: ORDER, CULTURE_ORDER: CULTURE_ORDER,
                       has: has, of: of, isNamed: isNamed };
})(typeof window !== 'undefined' ? window : this);
