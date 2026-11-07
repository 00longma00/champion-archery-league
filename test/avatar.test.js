const test = require('node:test');
const assert = require('node:assert/strict');
const { generateProceduralAvatar, sanitizeSvg, generateAIAvatar } = require('../ai-avatar');

test('sanitizeSvg strips dangerous tags and normalizes viewBox', () => {
  const dirty = '<svg><script>alert("hack")</script><circle cx="50" cy="50" r="40" fill="red"/></svg>';
  const clean = sanitizeSvg(dirty);
  assert.ok(clean.includes('viewBox="0 0 100 100"'), 'Should add viewBox if missing');
  assert.ok(!clean.includes('<script>'), 'Should remove script tag');
  assert.ok(clean.includes('<circle'), 'Should preserve valid svg shapes');
});

test('generateProceduralAvatar generates valid SVG with archery components', () => {
  const avatar = generateProceduralAvatar('Snowy owl archer with silver quiver and recurve bow', 'Robin');
  assert.ok(avatar.id.startsWith('ai_robin_'), 'Avatar id should be prefixed by archer name');
  assert.equal(avatar.emoji, '🦉', 'Should match owl emoji for owl prompt');
  assert.ok(avatar.title.length > 0, 'Should have a title');
  assert.ok(avatar.svg.includes('<svg'), 'SVG must start with svg tag');
  assert.ok(avatar.svg.includes('</svg>'), 'SVG must end with svg closing tag');
  assert.ok(avatar.svg.includes('viewBox="0 0 100 100"'), 'SVG must have 100x100 viewBox');
  assert.ok(avatar.borderClass.includes('border-'), 'Should specify border class');
  assert.ok(avatar.bgClass.includes('bg-'), 'Should specify background class');
});

test('generateProceduralAvatar supports different keyword archetypes', () => {
  const falcon = generateProceduralAvatar('Peregrine falcon with golden recurve', 'Apollo');
  assert.equal(falcon.emoji, '🦅');

  const wolf = generateProceduralAvatar('Celtic wolf with forest cloak', 'Fenrir');
  assert.equal(wolf.emoji, '🐺');

  const fox = generateProceduralAvatar('Cyberpunk neon fox archer', 'Kitsune');
  assert.equal(fox.emoji, '🦊');
});

test('generateAIAvatar returns a complete avatar object with fallback resilience', async () => {
  const result = await generateAIAvatar({
    prompt: 'Fierce black panther archer with night vision visor',
    name: 'Shadow'
  });
  assert.equal(result.success, true);
  assert.ok(result.avatar);
  assert.ok(result.avatar.id);
  assert.ok(result.avatar.svg);
  assert.ok(result.avatar.title);
  assert.ok(result.avatar.species);
  assert.ok(result.avatar.traits);
});
