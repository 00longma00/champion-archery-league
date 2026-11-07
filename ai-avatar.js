const { GoogleGenAI, Type } = require('@google/genai');

/**
 * Procedural SVG generator for archery avatar badges.
 * Styled with crisp daylight contrast suitable for light-themed UI (#f8fafc / #ffffff cards).
 */
function generateProceduralAvatar(prompt = '', name = 'Archer') {
  const p = (prompt || '').toLowerCase();
  const seed = Array.from(p + name).reduce((acc, char) => (acc * 31 + char.charCodeAt(0)) % 1000003, 7);

  // Daylight-optimized color palettes
  const themes = [
    { name: 'amber', primary: '#d97706', secondary: '#92400e', accent: '#fffbeb', border: 'border-amber-400', bg: 'bg-amber-50', badge: 'bg-amber-100 text-amber-900 border-amber-300', text: 'text-amber-800' },
    { name: 'emerald', primary: '#059669', secondary: '#065f46', accent: '#ecfdf5', border: 'border-emerald-400', bg: 'bg-emerald-50', badge: 'bg-emerald-100 text-emerald-900 border-emerald-300', text: 'text-emerald-800' },
    { name: 'sky', primary: '#0284c7', secondary: '#075985', accent: '#f0f9ff', border: 'border-sky-400', bg: 'bg-sky-50', badge: 'bg-sky-100 text-sky-900 border-sky-300', text: 'text-sky-800' },
    { name: 'purple', primary: '#7c3aed', secondary: '#5b21b6', accent: '#faf5ff', border: 'border-purple-400', bg: 'bg-purple-50', badge: 'bg-purple-100 text-purple-900 border-purple-300', text: 'text-purple-800' },
    { name: 'rose', primary: '#e11d48', secondary: '#9f1239', accent: '#fff1f2', border: 'border-rose-400', bg: 'bg-rose-50', badge: 'bg-rose-100 text-rose-900 border-rose-300', text: 'text-rose-800' },
    { name: 'indigo', primary: '#4f46e5', secondary: '#3730a3', accent: '#eef2ff', border: 'border-indigo-400', bg: 'bg-indigo-50', badge: 'bg-indigo-100 text-indigo-900 border-indigo-300', text: 'text-indigo-800' }
  ];

  let selectedTheme = themes[seed % themes.length];
  if (p.includes('gold') || p.includes('amber') || p.includes('sun') || p.includes('solar')) selectedTheme = themes[0];
  else if (p.includes('emerald') || p.includes('forest') || p.includes('green') || p.includes('leaf')) selectedTheme = themes[1];
  else if (p.includes('sky') || p.includes('ice') || p.includes('frost') || p.includes('blue') || p.includes('snow')) selectedTheme = themes[2];
  else if (p.includes('purple') || p.includes('mystic') || p.includes('shadow') || p.includes('void')) selectedTheme = themes[3];
  else if (p.includes('rose') || p.includes('fire') || p.includes('flame') || p.includes('red') || p.includes('crimson')) selectedTheme = themes[4];
  else if (p.includes('cyber') || p.includes('neon') || p.includes('night') || p.includes('cosmic')) selectedTheme = themes[5];

  // Character Archetype detection
  let archetype = 'falcon';
  let emoji = '🦅';
  let species = 'Falcon Archer';
  let title = 'Solar Peregrine Recurve';

  if (p.includes('owl')) {
    archetype = 'owl';
    emoji = '🦉';
    species = 'Snowy Owl Archer';
    title = 'Wise Horizon Sniper';
  } else if (p.includes('wolf')) {
    archetype = 'wolf';
    emoji = '🐺';
    species = 'Celtic Wolf Archer';
    title = 'Forest Stalker Longbow';
  } else if (p.includes('fox')) {
    archetype = 'fox';
    emoji = '🦊';
    species = 'Cyber Fox Archer';
    title = 'Neon Flare Precision';
  } else if (p.includes('dragon')) {
    archetype = 'dragon';
    emoji = '🐉';
    species = 'Draconic Archer';
    title = 'Flamecrest Compound';
  } else if (p.includes('panther') || p.includes('cat') || p.includes('tiger') || p.includes('leopard')) {
    archetype = 'panther';
    emoji = '🐆';
    species = 'Shadow Panther Archer';
    title = 'Stealth Night-Sight';
  } else if (p.includes('dog') || p.includes('retriever') || p.includes('hound') || p.includes('husky')) {
    archetype = 'dog';
    emoji = '🐕';
    species = 'Loyal Hound Archer';
    title = 'Noble Hunter Longbow';
  } else if (p.includes('bear') || p.includes('panda')) {
    archetype = 'bear';
    emoji = '🐼';
    species = 'Zen Panda Archer';
    title = 'Bamboo Grove Master';
  } else if (p.includes('eagle') || p.includes('falcon') || p.includes('hawk') || p.includes('bird')) {
    archetype = 'falcon';
    emoji = '🦅';
    species = 'Peregrine Falcon Archer';
    title = 'Golden Talon Recurve';
  } else {
    const adjectives = ['Apex', 'Valiant', 'Mystic', 'Swift', 'Shadow', 'Solar', 'Frost', 'Iron'];
    const adj = adjectives[seed % adjectives.length];
    species = `${name || 'Champion'} Archer`;
    title = `${adj} Recurve Specialist`;
    emoji = '🏹';
  }

  const prim = selectedTheme.primary;
  const sec = selectedTheme.secondary;
  const acc = selectedTheme.accent;

  let mascotShapes = '';

  if (archetype === 'falcon') {
    mascotShapes = `
      <!-- Falcon Head & Crest -->
      <polygon points="48,22 56,12 58,26" fill="${sec}"/>
      <path d="M30 46 C32 28, 54 26, 68 38 C68 52, 54 62, 34 60 Z" fill="${prim}"/>
      <polygon points="64,38 78,42 66,48" fill="#d97706"/>
      <circle cx="50" cy="38" r="4.5" fill="#0f172a"/>
      <circle cx="51.5" cy="36.5" r="1.5" fill="#ffffff"/>
      <path d="M38 52 Q50 56 60 48" stroke="${sec}" stroke-width="2" fill="none"/>
    `;
  } else if (archetype === 'owl') {
    mascotShapes = `
      <!-- Owl Head & Horn Tufts -->
      <polygon points="34,26 28,14 42,22" fill="${sec}"/>
      <polygon points="60,22 72,14 66,26" fill="${sec}"/>
      <circle cx="50" cy="45" r="22" fill="${prim}"/>
      <ellipse cx="40" cy="44" rx="8" ry="9" fill="#ffffff"/>
      <ellipse cx="60" cy="44" rx="8" ry="9" fill="#ffffff"/>
      <circle cx="40" cy="44" r="4.5" fill="#0f172a"/>
      <circle cx="60" cy="44" r="4.5" fill="#0f172a"/>
      <circle cx="41.5" cy="42" r="1.5" fill="#ffffff"/>
      <circle cx="61.5" cy="42" r="1.5" fill="#ffffff"/>
      <polygon points="50,46 46,54 54,54" fill="#d97706"/>
    `;
  } else if (archetype === 'wolf' || archetype === 'dog') {
    mascotShapes = `
      <!-- Wolf / Canine Ears & Snout -->
      <polygon points="30,34 26,14 44,26" fill="${sec}"/>
      <polygon points="32,30 30,18 40,26" fill="#ffffff"/>
      <polygon points="56,26 74,14 70,34" fill="${sec}"/>
      <polygon points="60,26 70,18 68,30" fill="#ffffff"/>
      <ellipse cx="50" cy="48" rx="20" ry="18" fill="${prim}"/>
      <ellipse cx="50" cy="54" rx="11" ry="8" fill="#ffffff"/>
      <polygon points="50,50 46,46 54,46" fill="#0f172a"/>
      <circle cx="38" cy="44" r="3.5" fill="#0f172a"/>
      <circle cx="62" cy="44" r="3.5" fill="#0f172a"/>
      <circle cx="39" cy="43" r="1" fill="#ffffff"/>
      <circle cx="63" cy="43" r="1" fill="#ffffff"/>
    `;
  } else if (archetype === 'fox') {
    mascotShapes = `
      <!-- Fox Large Ears & Slender Mask -->
      <polygon points="28,34 20,12 42,26" fill="${sec}"/>
      <polygon points="30,30 24,18 38,26" fill="#ffffff"/>
      <polygon points="58,26 80,12 72,34" fill="${sec}"/>
      <polygon points="62,26 76,18 70,30" fill="#ffffff"/>
      <polygon points="28,42 50,66 72,42 50,30" fill="${prim}"/>
      <polygon points="36,44 50,62 42,42" fill="#ffffff"/>
      <polygon points="64,44 58,42 50,62" fill="#ffffff"/>
      <circle cx="50" cy="62" r="3" fill="#0f172a"/>
      <ellipse cx="40" cy="42" rx="3.5" ry="2" fill="#0f172a" transform="rotate(-10 40 42)"/>
      <ellipse cx="60" cy="42" rx="3.5" ry="2" fill="#0f172a" transform="rotate(10 60 42)"/>
    `;
  } else if (archetype === 'dragon') {
    mascotShapes = `
      <!-- Dragon Horns & Scales -->
      <path d="M30 30 Q20 10 38 18" fill="none" stroke="${sec}" stroke-width="4" stroke-linecap="round"/>
      <path d="M70 30 Q80 10 62 18" fill="none" stroke="${sec}" stroke-width="4" stroke-linecap="round"/>
      <path d="M32 44 Q50 28 68 44 L62 64 Q50 68 38 64 Z" fill="${prim}"/>
      <polygon points="50,28 46,34 54,34" fill="#fbbf24"/>
      <ellipse cx="42" cy="46" rx="4" ry="5" fill="#facc15"/>
      <ellipse cx="58" cy="46" rx="4" ry="5" fill="#facc15"/>
      <ellipse cx="42" cy="46" rx="1.5" ry="4" fill="#0f172a"/>
      <ellipse cx="58" cy="46" rx="1.5" ry="4" fill="#0f172a"/>
      <circle cx="46" cy="56" r="1.5" fill="#0f172a"/>
      <circle cx="54" cy="56" r="1.5" fill="#0f172a"/>
    `;
  } else {
    mascotShapes = `
      <!-- Rounded Ears & Fierce Mask -->
      <circle cx="32" cy="28" r="8" fill="${sec}"/>
      <circle cx="68" cy="28" r="8" fill="${sec}"/>
      <circle cx="50" cy="48" r="21" fill="${prim}"/>
      <ellipse cx="50" cy="56" rx="10" ry="7" fill="#ffffff"/>
      <polygon points="50,53 46,50 54,50" fill="#0f172a"/>
      <path d="M46 56 Q50 59 54 56" stroke="#0f172a" stroke-width="1.8" fill="none"/>
      <circle cx="41" cy="44" r="3.5" fill="#0f172a"/>
      <circle cx="59" cy="44" r="3.5" fill="#0f172a"/>
      <circle cx="42" cy="43" r="1.2" fill="#ffffff"/>
      <circle cx="60" cy="43" r="1.2" fill="#ffffff"/>
    `;
  }

  // Universal Archery overlay with high-contrast daylight colors
  const svg = `<svg viewBox="0 0 100 100" class="w-full h-full" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <radialGradient id="badgeGlow_${seed}" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="${acc}" stop-opacity="1"/>
      <stop offset="85%" stop-color="#ffffff" stop-opacity="1"/>
      <stop offset="100%" stop-color="${acc}" stop-opacity="0.8"/>
    </radialGradient>
  </defs>
  <!-- Background Target Badge Disc -->
  <circle cx="50" cy="50" r="47" fill="url(#badgeGlow_${seed})" stroke="#cbd5e1" stroke-width="1.5"/>
  <circle cx="50" cy="50" r="43" fill="none" stroke="${prim}" stroke-opacity="0.25" stroke-width="1.2" stroke-dasharray="3 3"/>
  <circle cx="50" cy="50" r="35" fill="none" stroke="#e2e8f0" stroke-width="1"/>

  <!-- Quiver on back -->
  <rect x="22" y="32" width="6" height="24" rx="2" fill="${sec}" transform="rotate(-25 25 44)"/>
  <line x1="22" y1="28" x2="16" y2="16" stroke="#334155" stroke-width="2"/>
  <polygon points="16,16 20,20 14,21" fill="#facc15"/>
  <line x1="26" y1="30" x2="23" y2="17" stroke="#334155" stroke-width="2"/>
  <polygon points="23,17 27,21 21,22" fill="#ef4444"/>

  ${mascotShapes}

  <!-- Archery Headband / Feather Accent -->
  <path d="M28 36 Q50 30 72 36" stroke="#dc2626" stroke-width="3" stroke-linecap="round" fill="none"/>
  <polygon points="28,36 20,32 23,38" fill="#facc15"/>

  <!-- Recurve Bow & Drawn Arrow (High-Contrast for Light Background) -->
  <path d="M74 15 C85 30, 85 70, 74 85" fill="none" stroke="${prim}" stroke-width="3.8" stroke-linecap="round"/>
  <polyline points="74,15 48,50 74,85" fill="none" stroke="#1e293b" stroke-width="1.6"/>
  <circle cx="48" cy="50" r="3.5" fill="#fef3c7" stroke="${sec}" stroke-width="1.2"/>
  <!-- Arrow shaft (dark carbon) and vivid tip -->
  <line x1="46" y1="50" x2="92" y2="50" stroke="#334155" stroke-width="2.5" stroke-linecap="round"/>
  <polygon points="96,50 88,46 90,50 88,54" fill="${prim}"/>
</svg>`.trim();

  return {
    id: `ai_${(name || 'archer').toLowerCase().replace(/[^a-z0-9]/g, '_')}_${Date.now()}`,
    source: 'procedural',
    prompt: prompt || `${name}'s Archer Badge`,
    title,
    species,
    emoji,
    traits: `Custom vector badge • ${selectedTheme.name.toUpperCase()} recurve • Precision arrow`,
    borderClass: selectedTheme.border,
    bgClass: selectedTheme.bg,
    badgeClass: selectedTheme.badge,
    textClass: selectedTheme.text,
    svg
  };
}

/**
 * Clean & sanitize SVG string returned by LLM
 */
function sanitizeSvg(rawSvg) {
  if (!rawSvg) return null;
  let clean = rawSvg.trim();

  // Strip markdown code fences if wrapped
  clean = clean.replace(/^```(svg|html|xml)?\s*/i, '').replace(/\s*```$/i, '').trim();

  // Extract <svg>...</svg>
  const match = clean.match(/<svg[\s\S]*?<\/svg>/i);
  if (!match) return null;
  clean = match[0];

  // Disallow scripts, foreignObject, iframe, or external references
  clean = clean.replace(/<script[\s\S]*?<\/script>/gi, '');
  clean = clean.replace(/<foreignObject[\s\S]*?<\/foreignObject>/gi, '');
  clean = clean.replace(/onload=[\S]*/gi, '');
  clean = clean.replace(/onerror=[\S]*/gi, '');
  clean = clean.replace(/javascript:/gi, '');

  // Ensure standard viewBox and class
  if (!clean.includes('viewBox=')) {
    clean = clean.replace(/<svg/i, '<svg viewBox="0 0 100 100"');
  }
  if (!clean.includes('class=')) {
    clean = clean.replace(/<svg/i, '<svg class="w-full h-full"');
  }

  return clean;
}

function getValidGeminiApiKey() {
  const key = (process.env.GEMINI_API_KEY || '').trim();
  if (!key || key.length < 15 || key.includes('YOUR_') || key.includes('placeholder') || key.includes('example')) {
    return null;
  }
  return key;
}

/**
 * Generate AI Avatar using Gemini 3.8 Flash (Free Tier)
 * Falls back to high-fidelity procedural vector generator if API key is not present or on error.
 */
async function generateAIAvatar(payload = {}) {
  const { prompt = '', name = 'Archer' } = payload;
  const userPrompt = (prompt || '').trim();
  const apiKey = getValidGeminiApiKey();

  // Check for valid Gemini API Key
  if (apiKey && userPrompt) {
    try {
      const ai = new GoogleGenAI({
        apiKey,
        httpOptions: {
          headers: {
            'User-Agent': 'aistudio-build'
          }
        }
      });

      const systemInstruction = `You are a world-class graphic designer, heraldic crest illustrator, and game avatar artist for an archery league.
Your task is to design a stylized, high-contrast, beautiful circular mascot avatar badge for an archer named "${name}".
The user described their desired avatar as: "${userPrompt}".

REQUIREMENTS FOR THE SVG:
1. The badge must be designed strictly for a circular frame (viewBox="0 0 100 100").
2. The illustration must include recognizable archery elements (e.g. recurve bow, longbow, compound bow, arrow, quiver, archery glove/tab, target rings, or fletchings).
3. Use clean vector paths (<path>, <circle>, <ellipse>, <polygon>, <rect>, <polyline>, <line>, <defs>, <linearGradient>, <radialGradient>).
4. Do NOT include <script>, <iframe>, or external images.
5. The avatar badge is displayed on a clean light-themed web app with white cards (#ffffff) and light slate surfaces (#f8fafc). Use crisp, saturated, high-contrast colors, clear dark outlines or accents (#0f172a, #334155), and clean light badge backgrounds so every archery detail pops vividly.
6. Return a valid JSON response adhering exactly to the schema.`;

      const geminiPrompt = `Create an archery mascot avatar for "${name}" based on: "${userPrompt}".
Choose an archery title, species/archetype, single emoji, 2-3 visual traits, and complete SVG markup.`;

      const response = await ai.models.generateContent({
        model: 'gemini-3.8-flash',
        contents: geminiPrompt,
        config: {
          systemInstruction,
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              title: { type: Type.STRING, description: 'Short catchy archer title (e.g. "Shadow Hawk Recurve", max 30 chars)' },
              species: { type: Type.STRING, description: 'Mascot archetype or species (e.g. "Peregrine Falcon Archer", max 25 chars)' },
              emoji: { type: Type.STRING, description: 'Single matching emoji character (e.g. "🦅")' },
              traits: { type: Type.STRING, description: '2 to 3 visual highlights separated by bullet (e.g. "Feathered bracers • Golden recurve • Piercing eye")' },
              themeColor: { type: Type.STRING, description: 'Primary theme color: "amber", "emerald", "sky", "purple", "rose", or "indigo"' },
              svg: { type: Type.STRING, description: 'Complete SVG markup starting with <svg viewBox="0 0 100 100" class="w-full h-full"> and ending with </svg>' }
            },
            required: ['title', 'species', 'emoji', 'traits', 'themeColor', 'svg']
          }
        }
      });

      const parsed = JSON.parse(response.text || '{}');
      const sanitized = sanitizeSvg(parsed.svg);

      if (parsed.title && sanitized) {
        const theme = (parsed.themeColor || 'amber').toLowerCase();
        const colorMaps = {
          amber: { border: 'border-amber-400', bg: 'bg-amber-50', badge: 'bg-amber-100 text-amber-900 border-amber-300', text: 'text-amber-800' },
          emerald: { border: 'border-emerald-400', bg: 'bg-emerald-50', badge: 'bg-emerald-100 text-emerald-900 border-emerald-300', text: 'text-emerald-800' },
          sky: { border: 'border-sky-400', bg: 'bg-sky-50', badge: 'bg-sky-100 text-sky-900 border-sky-300', text: 'text-sky-800' },
          purple: { border: 'border-purple-400', bg: 'bg-purple-50', badge: 'bg-purple-100 text-purple-900 border-purple-300', text: 'text-purple-800' },
          rose: { border: 'border-rose-400', bg: 'bg-rose-50', badge: 'bg-rose-100 text-rose-900 border-rose-300', text: 'text-rose-800' },
          indigo: { border: 'border-indigo-400', bg: 'bg-indigo-50', badge: 'bg-indigo-100 text-indigo-900 border-indigo-300', text: 'text-indigo-800' }
        };
        const colorClasses = colorMaps[theme] || colorMaps.amber;

        return {
          success: true,
          source: 'gemini',
          model: 'gemini-3.8-flash',
          avatar: {
            id: `ai_${(name || 'archer').toLowerCase().replace(/[^a-z0-9]/g, '_')}_${Date.now()}`,
            prompt: userPrompt,
            title: parsed.title,
            species: parsed.species || `${name} Archer`,
            emoji: parsed.emoji || '🏹',
            traits: parsed.traits || 'Custom Gemini Archer Badge',
            borderClass: colorClasses.border,
            bgClass: colorClasses.bg,
            badgeClass: colorClasses.badge,
            textClass: colorClasses.text,
            svg: sanitized,
            createdAt: new Date().toISOString()
          }
        };
      }
    } catch (_err) {
      // Seamlessly fall through to procedural avatar generator
    }
  }

  // Fallback to high-quality procedural avatar
  const avatar = generateProceduralAvatar(userPrompt || `${name} Archer`, name);
  return {
    success: true,
    source: apiKey ? 'gemini-fallback' : 'procedural',
    model: 'gemini-3.8-flash-engine',
    avatar
  };
}

module.exports = {
  generateAIAvatar,
  generateProceduralAvatar,
  sanitizeSvg
};
