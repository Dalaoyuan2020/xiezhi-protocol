// Shared with the live scholar Agent. Spellings widen candidate retrieval;
// they never establish that two public records belong to the same person.
export function nameVariants(input, transliterate) {
  const q = String(input || '').trim();
  if (!/[一-鿿]/.test(q)) {
    const parts = q.split(/\s+/);
    const forms = new Set([q]);
    parts.forEach((part, i) => {
      const match = part.match(/^(l|n)(v|yu|u)$/i);
      if (!match) return;
      for (const u of ['v', 'yu', 'u']) forms.add(parts.map((x, j) => j === i ? match[1] + u : x).join(' '));
    });
    return [...forms].map(f => f.replace(/\b\w/g, c => c.toUpperCase()));
  }
  const syllables = transliterate(q, { toneType: 'none', type: 'array', v: true });
  if (syllables.length < 2) return [syllables.join('')];
  const [family, ...given] = syllables;
  const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
  const families = new Set([family, family.replace('v', 'yu'), family.replace('v', 'u')]);
  return [...families].map(f => `${cap(given.join(''))} ${cap(f)}`);
}
