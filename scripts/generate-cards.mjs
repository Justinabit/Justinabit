#!/usr/bin/env node
// Generates the animated SVGs used by README.md (header, stats, languages,
// featured repo cards, footer) from live GitHub data.
//
//   GITHUB_TOKEN=<token> node scripts/generate-cards.mjs
//
// No dependencies: needs Node 18+ for global fetch. Edit profile.config.json
// to change your info, typing lines or featured repos.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'assets');
const ENDPOINT = process.env.GITHUB_GRAPHQL_URL || 'https://api.github.com/graphql';
const TOKEN = process.env.GITHUB_TOKEN;

// ---------------------------------------------------------------------------
// GitHub data
// ---------------------------------------------------------------------------

async function gql(query, variables = {}) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      'User-Agent': 'profile-cards',
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`GraphQL HTTP ${res.status}: ${await res.text()}`);
  const json = await res.json();
  if (json.errors?.length) throw new Error(`GraphQL: ${json.errors.map((e) => e.message).join('; ')}`);
  return json.data;
}

const PROFILE_QUERY = `
query($login: String!, $after: String) {
  user(login: $login) {
    name
    login
    createdAt
    pullRequests { totalCount }
    repositories(first: 100, after: $after, ownerAffiliations: OWNER, privacy: PUBLIC) {
      totalCount
      pageInfo { hasNextPage endCursor }
      nodes {
        name
        isFork
        stargazerCount
        forkCount
        languages(first: 20, orderBy: { field: SIZE, direction: DESC }) {
          edges { size node { name color } }
        }
      }
    }
    contributionsCollection {
      contributionCalendar {
        totalContributions
        weeks { contributionDays { date contributionCount } }
      }
    }
  }
}`;

async function fetchProfile(login) {
  let after = null;
  let user;
  const repos = [];
  do {
    const data = await gql(PROFILE_QUERY, { login, after });
    if (!data.user) throw new Error(`User "${login}" not found`);
    user ??= data.user;
    repos.push(...data.user.repositories.nodes);
    const page = data.user.repositories.pageInfo;
    after = page.hasNextPage ? page.endCursor : null;
  } while (after);
  return { user, repos };
}

// contributionsCollection spans at most one year, so ask for every year since
// the account was created in a single aliased query.
async function fetchAllTimeCommits(login, createdAt) {
  const now = new Date();
  const fields = [];
  for (let y = new Date(createdAt).getUTCFullYear(); y <= now.getUTCFullYear(); y++) {
    const from = `${y}-01-01T00:00:00Z`;
    const to = y === now.getUTCFullYear() ? now.toISOString() : `${y}-12-31T23:59:59Z`;
    fields.push(`y${y}: contributionsCollection(from: "${from}", to: "${to}") { totalCommitContributions }`);
  }
  const data = await gql(`query($login: String!) { user(login: $login) { ${fields.join(' ')} } }`, { login });
  return Object.values(data.user).reduce((sum, c) => sum + c.totalCommitContributions, 0);
}

async function fetchFeatured(owner, featured) {
  if (!featured.length) return [];
  const fields = featured.map(
    (f, i) => `r${i}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(f.repo)}) { ...R }`,
  );
  const data = await gql(`
    query { ${fields.join(' ')} }
    fragment R on Repository {
      name description url homepageUrl stargazerCount forkCount
      primaryLanguage { name color }
      defaultBranchRef { target { ... on Commit { history { totalCount } } } }
    }`);
  return featured
    .map((f, i) => {
      const r = data[`r${i}`];
      if (!r) {
        console.warn(`! Featured repo "${f.repo}" not found, skipping`);
        return null;
      }
      return {
        ...f,
        name: r.name,
        title: f.title || r.name,
        tagline: f.tagline || r.description || '',
        demo: f.demo === undefined ? r.homepageUrl : f.demo,
        stars: r.stargazerCount,
        forks: r.forkCount,
        language: r.primaryLanguage,
        commits: r.defaultBranchRef?.target?.history?.totalCount ?? 0,
      };
    })
    .filter(Boolean);
}

function streaks(days) {
  let longest = 0;
  let run = 0;
  for (const d of days) {
    run = d.count > 0 ? run + 1 : 0;
    longest = Math.max(longest, run);
  }
  // A quiet "today" doesn't break the streak yet.
  let i = days.length - 1;
  if (i >= 0 && days[i].count === 0) i--;
  let current = 0;
  while (i >= 0 && days[i].count > 0) {
    current++;
    i--;
  }
  return { current, longest };
}

function aggregateLanguages(repos, { max = 8, exclude = [] }) {
  const skip = new Set(exclude.map((l) => l.toLowerCase()));
  const byName = new Map();
  let repoCount = 0;
  for (const repo of repos) {
    if (repo.isFork || !repo.languages.edges.length) continue;
    repoCount++;
    for (const { size, node } of repo.languages.edges) {
      if (skip.has(node.name.toLowerCase())) continue;
      const entry = byName.get(node.name) ?? { name: node.name, color: node.color || '#8b949e', size: 0 };
      entry.size += size;
      byName.set(node.name, entry);
    }
  }
  const all = [...byName.values()].sort((a, b) => b.size - a.size);
  const total = all.reduce((s, l) => s + l.size, 0) || 1;
  let top = all.slice(0, max);
  if (all.length > max) {
    top = all.slice(0, max - 1);
    const rest = all.slice(max - 1).reduce((s, l) => s + l.size, 0);
    top.push({ name: 'Other', color: '#8b949e', size: rest });
  }
  return { repoCount, list: top.map((l) => ({ ...l, pct: (l.size / total) * 100 })) };
}

function computeAge(config) {
  if (!config.birthday) return config.age;
  const b = new Date(`${config.birthday}T00:00:00Z`);
  const now = new Date();
  let age = now.getUTCFullYear() - b.getUTCFullYear();
  const beforeBirthday =
    now.getUTCMonth() < b.getUTCMonth() ||
    (now.getUTCMonth() === b.getUTCMonth() && now.getUTCDate() < b.getUTCDate());
  return beforeBirthday ? age - 1 : age;
}

// ---------------------------------------------------------------------------
// SVG helpers
// ---------------------------------------------------------------------------

const SANS = `-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans', Helvetica, Arial, sans-serif`;
const MONO = `ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace`;

const THEMES = {
  dark: {
    card: '#0d1117', border: '#2b3b30', tile: '#161b22', tileBorder: '#21262d',
    title: '#e6edf3', text: '#c9d1d9', muted: '#8b949e',
    accent: '#3fb950', accentSoft: '#7ee787', track: '#21262d',
    chip: '#12261a', chipBorder: '#1f4a2c', chipText: '#7ee787', glow: 0.16,
  },
  light: {
    card: '#ffffff', border: '#cfe3d4', tile: '#f6f8fa', tileBorder: '#e1e7ec',
    title: '#1f2328', text: '#31373d', muted: '#59636e',
    accent: '#1a7f37', accentSoft: '#1a7f37', track: '#eaeef2',
    chip: '#e9f8ed', chipBorder: '#b7e4c2', chipText: '#116329', glow: 0.09,
  },
};

// GitHub Octicons (MIT), 16px.
const ICONS = {
  repo: 'M2 2.5A2.5 2.5 0 0 1 4.5 0h8.75a.75.75 0 0 1 .75.75v12.5a.75.75 0 0 1-.75.75h-2.5a.75.75 0 0 1 0-1.5h1.75v-2h-8a1 1 0 0 0-.714 1.7.75.75 0 1 1-1.072 1.05A2.495 2.495 0 0 1 2 11.5Zm10.5-1h-8a1 1 0 0 0-1 1v6.708A2.486 2.486 0 0 1 4.5 9h8ZM5 12.25a.25.25 0 0 1 .25-.25h3.5a.25.25 0 0 1 .25.25v3.25a.25.25 0 0 1-.4.2l-1.45-1.087a.249.249 0 0 0-.3 0L5.4 15.7a.25.25 0 0 1-.4-.2Z',
  star: 'M8 .25a.75.75 0 0 1 .673.418l1.882 3.815 4.21.612a.75.75 0 0 1 .416 1.279l-3.046 2.97.719 4.192a.751.751 0 0 1-1.088.791L8 12.347l-3.766 1.98a.75.75 0 0 1-1.088-.79l.72-4.194L.818 6.374a.75.75 0 0 1 .416-1.28l4.21-.611L7.327.668A.75.75 0 0 1 8 .25Zm0 2.445L6.615 5.5a.75.75 0 0 1-.564.41l-3.097.45 2.24 2.184a.75.75 0 0 1 .216.664l-.528 3.084 2.769-1.456a.75.75 0 0 1 .698 0l2.77 1.456-.53-3.084a.75.75 0 0 1 .216-.664l2.24-2.183-3.096-.45a.75.75 0 0 1-.564-.41L8 2.694Z',
  commit: 'M11.93 8.5a4.002 4.002 0 0 1-7.86 0H.75a.75.75 0 0 1 0-1.5h3.32a4.002 4.002 0 0 1 7.86 0h3.32a.75.75 0 0 1 0 1.5Zm-1.43-.75a2.5 2.5 0 1 0-5 0 2.5 2.5 0 0 0 5 0Z',
  pr: 'M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354ZM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm8.25.75a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Z',
  flame: 'M9.533.753V.752c.217 2.385 1.463 3.626 2.653 4.81C13.37 6.74 14.498 7.863 14.498 10c0 3.5-3 6-6.5 6S1.5 13.512 1.5 10c0-1.298.536-2.56 1.425-3.286.376-.308.862 0 1.035.454C4.46 8.487 5.581 8.419 6 8c.282-.282.341-.811-.003-1.5C4.34 3.187 7.035.75 8.77.146c.39-.137.726.204.763.607ZM7.998 14.5c2.832 0 5-1.98 5-4.5 0-1.463-.68-2.19-1.879-3.383l-.036-.037c-1.013-1.008-2.3-2.29-2.834-4.434-.322.256-.63.579-.864.953-.432.696-.621 1.58-.046 2.73.473.947.67 2.284-.278 3.232-.61.61-1.545.84-2.403.633a2.79 2.79 0 0 1-1.436-.874A3.198 3.198 0 0 0 3 10c0 2.53 2.164 4.5 4.998 4.5Z',
  graph: 'M1.5 1.75V13.5h13.75a.75.75 0 0 1 0 1.5H.75a.75.75 0 0 1-.75-.75V1.75a.75.75 0 0 1 1.5 0Zm14.28 2.53-5.25 5.25a.75.75 0 0 1-1.06 0L7 7.06 4.28 9.78a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042l3.25-3.25a.75.75 0 0 1 1.06 0L10 7.94l4.72-4.72a.751.751 0 0 1 1.042.018.751.751 0 0 1 .018 1.042Z',
  code: 'm11.28 3.22 4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.749.749 0 0 1-1.275-.326.749.749 0 0 1 .215-.734L13.94 8l-3.72-3.72a.749.749 0 0 1 .326-1.275.749.749 0 0 1 .734.215Zm-6.56 0a.751.751 0 0 1 1.042.018.751.751 0 0 1 .018 1.042L2.06 8l3.72 3.72a.749.749 0 0 1-.326 1.275.749.749 0 0 1-.734-.215L.47 8.53a.75.75 0 0 1 0-1.06Z',
  'mortar-board': 'M7.693 1.066a.747.747 0 0 1 .614 0l7.25 3.25a.75.75 0 0 1 0 1.368L13 6.831v2.794c0 1.024-.81 1.749-1.66 2.173-.893.447-2.075.702-3.34.702-.278 0-.55-.012-.816-.036a.75.75 0 0 1 .133-1.494c.22.02.45.03.683.03 1.082 0 2.025-.221 2.67-.543.69-.345.83-.682.83-.832V7.503L8.307 8.934a.747.747 0 0 1-.614 0L4 7.28v1.663c.296.105.575.275.812.512.438.438.688 1.059.688 1.796v3a.75.75 0 0 1-.75.75h-3a.75.75 0 0 1-.75-.75v-3c0-.737.25-1.358.688-1.796.237-.237.516-.407.812-.512V6.606L.443 5.684a.75.75 0 0 1 0-1.368ZM2.583 5 8 7.428 13.417 5 8 2.572ZM2.5 11.25v2.25H4v-2.25c0-.388-.125-.611-.25-.735a.697.697 0 0 0-.5-.203.707.707 0 0 0-.5.203c-.125.124-.25.347-.25.735Z',
  location: 'm12.596 11.596-3.535 3.536a1.5 1.5 0 0 1-2.122 0l-3.535-3.536a6.5 6.5 0 1 1 9.192-9.193 6.5 6.5 0 0 1 0 9.193Zm-1.06-8.132v-.001a5 5 0 1 0-7.072 7.072L8 14.07l3.536-3.534a5 5 0 0 0 0-7.072ZM8 9a2 2 0 1 1-.001-3.999A2 2 0 0 1 8 9Z',
  person: 'M10.561 8.073a6.005 6.005 0 0 1 3.432 5.142.75.75 0 1 1-1.498.07 4.5 4.5 0 0 0-8.99 0 .75.75 0 0 1-1.498-.07 6.004 6.004 0 0 1 3.431-5.142 3.999 3.999 0 1 1 5.123 0ZM10.5 5a2.5 2.5 0 1 0-5 0 2.5 2.5 0 0 0 5 0Z',
};

const icon = (name, x, y, color, size = 16) =>
  `<path transform="translate(${x} ${y}) scale(${size / 16})" fill="${color}" d="${ICONS[name] ?? ICONS.code}"/>`;

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const r1 = (n) => Math.round(n * 10) / 10;

// Approximate Helvetica/Arial advance widths (1/1000 em) for layout math.
const ADV = (() => {
  const t = {};
  const set = (chars, w) => [...chars].forEach((c) => (t[c] = w));
  set(" !',./:;I[\\]fijlt|", 278);
  set('"', 355);
  set('#$0123456789?L_abdeghnopqu', 556);
  set('%', 889);
  set('&ABEKPSVXY', 667);
  set('()-`r', 333);
  set('*', 389);
  set('+<=>~', 584);
  set('@', 1015);
  set('CDHNRUw', 722);
  set('FTZ', 611);
  set('GOQ', 778);
  set('J', 500);
  set('M', 833);
  set('W', 944);
  set('^', 469);
  set('ckvsxyz', 500);
  set('m', 833);
  set('{}', 334);
  return t;
})();

function textWidth(str, size, bold = false) {
  let w = 0;
  for (const c of str) w += ADV[c] ?? 600;
  // System UI fonts run slightly wider than Arial; pad so nothing collides.
  return (w / 1000) * size * (bold ? 1.1 : 1.05);
}

function wrap(text, size, maxWidth, maxLines) {
  const lines = [];
  let line = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const next = line ? `${line} ${word}` : word;
    if (textWidth(next, size) <= maxWidth || !line) {
      line = next;
    } else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    let last = kept[maxLines - 1];
    while (textWidth(`${last}…`, size) > maxWidth && last.includes(' ')) last = last.slice(0, last.lastIndexOf(' '));
    kept[maxLines - 1] = `${last}…`;
    return kept;
  }
  return lines;
}

const fmtDate = (d, timeZone = 'UTC') => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone });

// Shared CSS. Every entrance animation only defines its `from` state, so with
// animations disabled (reduced motion) everything renders in its final state.
const baseCss = (extra = '') => `
  .s { font-family: ${SANS}; }
  .m { font-family: ${MONO}; }
  .fade { animation: fadeUp .8s cubic-bezier(.2,.7,.2,1) both; }
  @keyframes fadeUp { from { opacity: 0; transform: translateY(10px); } }
  .pop { animation: pop .6s cubic-bezier(.3,1.4,.5,1) both; transform-box: fill-box; transform-origin: center; }
  @keyframes pop { from { opacity: 0; transform: scale(.6); } }
  .pulse { animation: pulse 2s ease-in-out infinite; transform-box: fill-box; transform-origin: center; }
  @keyframes pulse { 50% { opacity: .35; transform: scale(1.6); } }
  ${extra}
  @media (prefers-reduced-motion: reduce) { * { animation: none !important; } }
`;

// Rolling "odometer" number: each digit is a vertical strip of 0-9 that rolls
// into place. Without animation the strip already rests on the final digit.
function odometer(value, { x, y, size, color, delay = 0, keyframes }) {
  const str = String(value);
  const dw = size * 0.62;
  const lh = Math.round(size * 1.3);
  const id = `od${odometer.n = (odometer.n ?? 0) + 1}`;
  const cols = [...str].map((ch, i) => {
    const cx = r1(x + dw * i + dw / 2);
    if (!/\d/.test(ch)) return `<text x="${cx}" y="${y}" text-anchor="middle">${esc(ch)}</text>`;
    const d = Number(ch);
    const kf = `roll${d}_${lh}`;
    keyframes.add(`@keyframes ${kf} { from { transform: translateY(${(d + 10) * lh}px); } }`);
    // 0-9 twice so every digit rolls at least one full turn.
    const strip = Array.from({ length: 20 }, (_, k) => `<text x="${cx}" y="${y + (k - d - 10) * lh}" text-anchor="middle">${k % 10}</text>`).join('');
    const dur = 1.2 + (str.length - i) * 0.25;
    return `<g style="animation: ${kf} ${dur}s cubic-bezier(.12,.8,.2,1) ${delay}s both">${strip}</g>`;
  });
  const w = dw * str.length;
  return {
    width: w,
    svg: `<clipPath id="${id}"><rect x="${x - 2}" y="${y - size}" width="${w + 4}" height="${size * 1.25}"/></clipPath>
      <g clip-path="url(#${id})" fill="${color}" font-size="${size}" font-weight="700" class="s" style="font-variant-numeric: tabular-nums">${cols.join('')}</g>`,
  };
}

function cardShell({ w, h, t, title, desc, css, body, glowAt = [0, 0] }) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-labelledby="title desc">
  <title id="title">${esc(title)}</title>
  <desc id="desc">${esc(desc)}</desc>
  <style>${css}</style>
  <defs>
    <radialGradient id="glow" cx="${glowAt[0]}" cy="${glowAt[1]}" r="${Math.max(w, h) * 0.75}" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#2ea043" stop-opacity="${t.glow}"/>
      <stop offset="1" stop-color="#2ea043" stop-opacity="0"/>
    </radialGradient>
    <clipPath id="card"><rect x="0.5" y="0.5" width="${w - 1}" height="${h - 1}" rx="14"/></clipPath>
  </defs>
  <rect x="0.5" y="0.5" width="${w - 1}" height="${h - 1}" rx="14" fill="${t.card}"/>
  <rect x="0.5" y="0.5" width="${w - 1}" height="${h - 1}" rx="14" fill="url(#glow)"/>
  ${body}
  <rect x="0.5" y="0.5" width="${w - 1}" height="${h - 1}" rx="14" fill="none" stroke="${t.border}"/>
</svg>
`;
}

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------

function renderStats(d, t) {
  const W = 480, H = 264;
  const keyframes = new Set();
  const tiles = [
    { icon: 'commit', label: 'Total Commits', value: d.totalCommits, suffix: 'all-time' },
    { icon: 'repo', label: 'Repositories', value: d.totalRepos, suffix: 'public' },
    { icon: 'graph', label: 'Contributions', value: d.contributions, suffix: 'past year' },
    { icon: 'star', label: 'Stars Earned', value: d.stars, suffix: '' },
    { icon: 'pr', label: 'Pull Requests', value: d.pullRequests, suffix: '' },
    { icon: 'flame', label: 'Day Streak', value: d.streak.current, suffix: `best ${d.streak.longest}` },
  ];
  const tw = 136, th = 74, gap = 12, x0 = 24, y0 = 64;
  const body = tiles
    .map((tile, i) => {
      const tx = x0 + (i % 3) * (tw + gap);
      const ty = y0 + Math.floor(i / 3) * (th + gap);
      const delay = r1(0.15 + i * 0.12);
      const num = odometer(tile.value, { x: tx + 14, y: ty + 59, size: 26, color: t.title, delay: delay + 0.1, keyframes });
      return `<g class="fade" style="animation-delay:${delay}s">
        <rect x="${tx}" y="${ty}" width="${tw}" height="${th}" rx="10" fill="${t.tile}" stroke="${t.tileBorder}"/>
        ${icon(tile.icon, tx + 14, ty + 13, t.accent, 14)}
        <text x="${tx + 34}" y="${ty + 25}" class="s" font-size="12" fill="${t.muted}">${esc(tile.label)}</text>
        ${num.svg}
        ${tile.suffix ? `<text x="${r1(tx + 14 + num.width + 6)}" y="${ty + 58}" class="s" font-size="11" fill="${t.muted}">${esc(tile.suffix)}</text>` : ''}
      </g>`;
    })
    .join('');
  const header = `<g class="fade">
      <text x="24" y="40" class="s" font-size="17" font-weight="700" fill="${t.title}">GitHub Stats</text>
      <text x="${W - 24}" y="40" text-anchor="end" class="m" font-size="12" fill="${t.muted}">@${esc(d.login)}</text>
    </g>`;
  const footer = `<text x="24" y="${H - 17}" class="s fade" style="animation-delay:.9s" font-size="11" fill="${t.muted}">Updated ${fmtDate(d.updated, d.timezone)} · refreshes daily</text>`;
  return cardShell({
    w: W, h: H, t,
    title: `${d.name}'s GitHub stats`,
    desc: `${d.totalCommits} total commits, ${d.totalRepos} public repositories, ${d.contributions} contributions in the past year, ${d.stars} stars, ${d.pullRequests} pull requests, ${d.streak.current}-day streak (best ${d.streak.longest}).`,
    css: baseCss([...keyframes].join('\n')),
    body: header + body + footer,
  });
}

function renderLanguages(d, t) {
  const W = 480, H = 264;
  const langs = d.languages.list;
  const barX = 24, barY = 62, barW = W - 48, barH = 10;
  let x = barX;
  const segs = langs
    .map((l) => {
      const w = (l.pct / 100) * barW;
      const seg = `<rect x="${r1(x)}" y="${barY}" width="${r1(Math.max(w, 0))}" height="${barH}" fill="${l.color}"/>`;
      x += w;
      return seg;
    })
    .join('');
  const bar = `<clipPath id="bar"><rect x="${barX}" y="${barY}" width="${barW}" height="${barH}" rx="5"/></clipPath>
    <rect x="${barX}" y="${barY}" width="${barW}" height="${barH}" rx="5" fill="${t.track}"/>
    <g clip-path="url(#bar)"><g class="grow">${segs}</g></g>`;
  const colW = (barW - 24) / 2;
  const rows = langs
    .map((l, i) => {
      const cx = barX + (i % 2) * (colW + 24);
      const cy = 108 + Math.floor(i / 2) * 31;
      return `<g class="fade" style="animation-delay:${r1(0.5 + i * 0.09)}s">
        <circle cx="${cx + 6}" cy="${cy - 4.5}" r="6" fill="${l.color}"/>
        <text x="${cx + 20}" y="${cy}" class="s" font-size="13.5" fill="${t.text}">${esc(l.name)}</text>
        <text x="${cx + colW}" y="${cy}" text-anchor="end" class="m" font-size="12.5" fill="${t.muted}">${l.pct.toFixed(1)}%</text>
      </g>`;
    })
    .join('');
  const header = `<g class="fade">
      <text x="24" y="40" class="s" font-size="17" font-weight="700" fill="${t.title}">Most Used Languages</text>
      <text x="${W - 24}" y="40" text-anchor="end" class="m" font-size="12" fill="${t.muted}">by code size</text>
    </g>`;
  const footer = `<text x="24" y="${H - 17}" class="s fade" style="animation-delay:1.2s" font-size="11" fill="${t.muted}">Across ${d.languages.repoCount} original repositories (forks excluded)</text>`;
  return cardShell({
    w: W, h: H, t,
    title: 'Most used languages',
    desc: langs.map((l) => `${l.name} ${l.pct.toFixed(1)}%`).join(', '),
    css: baseCss(`.grow { animation: grow 1.4s cubic-bezier(.3,.8,.2,1) .2s both; transform-origin: ${barX}px 0; }
      @keyframes grow { from { transform: scaleX(0); } }`),
    body: header + bar + rows + footer,
    glowAt: [W, 0],
  });
}

function renderRepo(repo, t, index) {
  const W = 480, H = 172;
  const parts = [];
  // Accent line with a light sweep.
  parts.push(`<g clip-path="url(#card)">
    <rect x="0" y="0" width="${W}" height="3" fill="url(#accent)"/>
    <rect class="sweep" x="-160" y="0" width="160" height="3" fill="url(#shine)" style="animation-delay:${r1(index * 0.6)}s"/>
  </g>`);
  parts.push(`<g class="fade">
    ${icon('repo', 24, 26, t.muted)}
    <text x="48" y="39.5" class="s" font-size="18" font-weight="700" fill="${t.accentSoft}">${esc(repo.title)}</text>
  </g>`);
  if (repo.demo) {
    const pw = 84, px = W - 24 - pw, py = 23;
    parts.push(`<g class="fade" style="animation-delay:.25s">
      <rect x="${px}" y="${py}" width="${pw}" height="22" rx="11" fill="${t.chip}" stroke="${t.chipBorder}"/>
      <circle cx="${px + 14}" cy="${py + 11}" r="3.5" fill="${t.accent}" class="pulse"/>
      <circle cx="${px + 14}" cy="${py + 11}" r="3.5" fill="${t.accent}"/>
      <text x="${px + 24}" y="${py + 15.5}" class="s" font-size="11.5" font-weight="600" fill="${t.chipText}">Live demo</text>
    </g>`);
  }
  const lines = wrap(repo.tagline, 13.5, W - 48, 2);
  parts.push(`<g class="fade" style="animation-delay:.15s">${lines
    .map((l, i) => `<text x="24" y="${70 + i * 20}" class="s" font-size="13.5" fill="${t.text}">${esc(l)}</text>`)
    .join('')}</g>`);
  let cx = 24;
  const chips = (repo.tech || [])
    .map((name, i) => {
      const w = textWidth(name, 11.5, true) + 20;
      if (cx + w > W - 24) return '';
      const chip = `<g class="pop" style="animation-delay:${r1(0.35 + i * 0.08)}s">
        <rect x="${r1(cx)}" y="108" width="${r1(w)}" height="22" rx="6" fill="${t.chip}" stroke="${t.chipBorder}"/>
        <text x="${r1(cx + w / 2)}" y="123" text-anchor="middle" class="s" font-size="11.5" font-weight="600" fill="${t.chipText}">${esc(name)}</text>
      </g>`;
      cx += w + 8;
      return chip;
    })
    .join('');
  parts.push(chips);
  let fx = 24;
  const fy = 155;
  const meta = [];
  if (repo.language) {
    meta.push(`<circle cx="${fx + 6}" cy="${fy - 4.5}" r="6" fill="${repo.language.color || '#8b949e'}"/>
      <text x="${fx + 18}" y="${fy}" class="s" font-size="12.5" fill="${t.muted}">${esc(repo.language.name)}</text>`);
    fx += 18 + textWidth(repo.language.name, 12.5) + 18;
  }
  meta.push(`${icon('star', fx, fy - 12.5, t.muted, 14)}<text x="${fx + 19}" y="${fy}" class="s" font-size="12.5" fill="${t.muted}">${repo.stars}</text>`);
  fx += 19 + textWidth(String(repo.stars), 12.5) + 18;
  const commits = `${repo.commits} commit${repo.commits === 1 ? '' : 's'}`;
  meta.push(`${icon('commit', fx, fy - 12, t.muted, 15)}<text x="${fx + 20}" y="${fy}" class="s" font-size="12.5" fill="${t.muted}">${commits}</text>`);
  parts.push(`<g class="fade" style="animation-delay:.55s">${meta.join('')}</g>`);

  const svg = cardShell({
    w: W, h: H, t,
    title: `${repo.title} repository`,
    desc: `${repo.tagline} Built with ${(repo.tech || []).join(', ')}. ${repo.stars} stars, ${commits}.`,
    css: baseCss(`.sweep { animation: sweep 4s ease-in-out infinite; }
      @keyframes sweep { from { transform: translateX(0); } 60%, to { transform: translateX(${W + 160}px); } }`),
    body: parts.join('\n'),
    glowAt: [index % 2 ? W : 0, 0],
  });
  return svg.replace(
    '</defs>',
    `<linearGradient id="accent" x1="0" x2="1"><stop offset="0" stop-color="#216e39"/><stop offset=".5" stop-color="#40c463"/><stop offset="1" stop-color="#9be9a8"/></linearGradient>
    <linearGradient id="shine" x1="0" x2="1"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset=".5" stop-color="#fff" stop-opacity=".9"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>
  </defs>`,
  );
}

// Seeded PRNG so the header looks the same on every run.
function rng(seed) {
  return () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
}

function shade(hex, amt) {
  const n = parseInt(hex.slice(1), 16);
  const ch = (v) => Math.max(0, Math.min(255, Math.round(v * (1 + amt))));
  return `#${[n >> 16, (n >> 8) & 255, n & 255].map((v) => ch(v).toString(16).padStart(2, '0')).join('')}`;
}

function isoCubes({ ox, oy, s }) {
  // Levels 0-5 on a 7x7 grid, drawn like a little 3D contribution graph.
  const L = [
    [0, 1, 0, 2, 1, 0, 1],
    [1, 2, 3, 1, 0, 2, 0],
    [0, 3, 5, 2, 1, 0, 1],
    [2, 1, 3, 4, 2, 1, 0],
    [0, 2, 1, 3, 2, 0, 2],
    [1, 0, 2, 1, 3, 2, 0],
    [0, 1, 0, 0, 2, 1, 1],
  ];
  const COLORS = ['', '#0e4429', '#006d32', '#26a641', '#39d353', '#7ee787'];
  const P = (gx, gy, z) => [r1(ox + (gx - gy) * s * 0.866), r1(oy + (gx + gy) * s * 0.5 - z * s)];
  const poly = (pts, fill, extra = '') => `<polygon points="${pts.map((p) => p.join(',')).join(' ')}" fill="${fill}" ${extra}/>`;
  const m = 0.1;
  const cells = [];
  for (let gy = 0; gy < 7; gy++) for (let gx = 0; gx < 7; gx++) cells.push([gx, gy, L[gy][gx]]);
  cells.sort((a, b) => a[0] + a[1] - (b[0] + b[1]));

  const floor = cells
    .map(([gx, gy]) => poly([P(gx + m, gy + m, 0), P(gx + 1 - m, gy + m, 0), P(gx + 1 - m, gy + 1 - m, 0), P(gx + m, gy + 1 - m, 0)], '#161b22', 'stroke="#22302a" stroke-width="1"'))
    .join('');
  const cols = cells
    .filter(([, , lv]) => lv > 0)
    .map(([gx, gy, lv]) => {
      const h = lv * 0.62;
      const c = COLORS[lv];
      const a = gx + m, b = gx + 1 - m, cc = gy + m, dd = gy + 1 - m;
      const top = [P(a, cc, h), P(b, cc, h), P(b, dd, h), P(a, dd, h)];
      const left = [P(a, dd, 0), P(b, dd, 0), P(b, dd, h), P(a, dd, h)];
      const right = [P(b, cc, 0), P(b, dd, 0), P(b, dd, h), P(b, cc, h)];
      const delay = r1(0.3 + (gx + gy) * 0.08);
      const wave = r1((gx + gy) * 0.25);
      return `<g class="rise" style="animation-delay:${delay}s">
        ${poly(left, shade(c, -0.25))}${poly(right, shade(c, -0.45))}${poly(top, c)}
        ${poly(top, '#ffffff', `class="shine" style="animation-delay:${wave + 2}s"`)}
      </g>`;
    })
    .join('');
  return floor + cols;
}

function renderHeader(cfg) {
  const W = 1200, H = 400;
  const rand = rng(7);
  const age = computeAge(cfg);
  const x0 = 72;

  // Typing line (SMIL so it works inside <img>). Monospace text is forced to
  // an exact width with textLength, so the reveal lines up with each letter.
  const fs = 24, cw = fs * 0.6, ty = 254, tx = x0 + 30;
  const typeStep = 0.06, delStep = 0.025, hold = 1.8, pause = 0.4;
  const slots = [];
  let tcur = 0;
  for (const phrase of cfg.typing) {
    const n = phrase.length;
    slots.push({ phrase, n, start: tcur });
    tcur += n * typeStep + hold + n * delStep + pause;
  }
  const T = tcur;
  const kt = (s) => (s / T).toFixed(4);
  const widthsFor = (slot) => {
    const times = [0];
    const vals = [0];
    for (let k = 1; k <= slot.n; k++) {
      times.push(slot.start + k * typeStep);
      vals.push(r1(k * cw));
    }
    const delStart = slot.start + slot.n * typeStep + hold;
    for (let k = 1; k <= slot.n; k++) {
      times.push(delStart + k * delStep);
      vals.push(r1((slot.n - k) * cw));
    }
    return { times, vals };
  };
  const typing = slots
    .map((slot, i) => {
      const { times, vals } = widthsFor(slot);
      return `<clipPath id="tc${i}"><rect x="${tx}" y="${ty - fs}" height="${fs + 10}" width="0">
          <animate attributeName="width" dur="${r1(T)}s" repeatCount="indefinite" calcMode="discrete" keyTimes="${times.map(kt).join(';')}" values="${vals.join(';')}"/>
        </rect></clipPath>
        <text x="${tx}" y="${ty}" clip-path="url(#tc${i})" class="m" font-size="${fs}" fill="#e6edf3" textLength="${r1(slot.n * cw)}" lengthAdjust="spacingAndGlyphs">${esc(slot.phrase)}</text>`;
    })
    .join('');
  // Cursor follows whichever phrase is active.
  const cTimes = [];
  const cVals = [];
  for (const slot of slots) {
    const { times, vals } = widthsFor(slot);
    times.slice(1).forEach((tm, k) => {
      cTimes.push(tm);
      cVals.push(r1(tx + vals[k + 1] + 2));
    });
  }
  const cursor = `<rect class="blink" x="${tx + 2}" y="${ty - fs + 2}" width="3" height="${fs + 2}" fill="#3fb950">
      <animate attributeName="x" dur="${r1(T)}s" repeatCount="indefinite" calcMode="discrete" keyTimes="0;${cTimes.map(kt).join(';')}" values="${tx + 2};${cVals.join(';')}"/>
    </rect>`;

  // Fact pills, wrapping to a second row if needed.
  const pillFs = 15, maxRight = 730;
  let px = x0, py = 296;
  const pills = cfg.facts
    .map((f, i) => {
      const text = f.text.replace('{age}', age);
      const w = 16 + 16 + 8 + textWidth(text, pillFs) + 16;
      if (px + w > maxRight && px > x0) {
        px = x0;
        py += 44;
      }
      const g = `<g class="fade" style="animation-delay:${r1(0.9 + i * 0.15)}s">
        <rect x="${r1(px)}" y="${py}" width="${r1(w)}" height="34" rx="17" fill="#0f2418" stroke="#1f4a2c"/>
        ${icon(f.icon, r1(px + 16), py + 9, '#7ee787')}
        <text x="${r1(px + 40)}" y="${py + 22.5}" class="s" font-size="${pillFs}" fill="#d1f5dc">${esc(text)}</text>
      </g>`;
      px += w + 10;
      return g;
    })
    .join('');

  const particles = Array.from({ length: 18 }, (_, i) => {
    const x = r1(620 + rand() * 560);
    const size = r1(2 + rand() * 4);
    const dur = r1(7 + rand() * 7);
    const delay = r1(-rand() * dur);
    const op = r1(0.25 + rand() * 0.5);
    return `<rect class="float" x="${x}" y="${H + 10}" width="${size}" height="${size}" rx="1" fill="${i % 3 ? '#39d353' : '#9be9a8'}" opacity="${op}" style="animation-duration:${dur}s;animation-delay:${delay}s"/>`;
  }).join('');

  const css = baseCss(`
    .rise { animation: rise 1s cubic-bezier(.2,.9,.25,1.15) both; transform-box: fill-box; transform-origin: 50% 100%; }
    @keyframes rise { from { transform: scaleY(0); opacity: 0; } 30% { opacity: 1; } }
    .shine { opacity: 0; animation: shine 5s ease-in-out infinite; }
    @keyframes shine { 0%, 100% { opacity: 0; } 10% { opacity: .28; } 25% { opacity: 0; } }
    .float { animation: float linear infinite; transform-box: fill-box; transform-origin: center; }
    @keyframes float { from { transform: translateY(0) rotate(0deg); } to { transform: translateY(-430px) rotate(360deg); } }
    .blink { animation: blink 1s steps(1) infinite; }
    @keyframes blink { 50% { opacity: 0; } }
    .name { animation: fadeUp 1s cubic-bezier(.2,.7,.2,1) .2s both; }
    .typing-static { display: none; }
    @media (prefers-reduced-motion: reduce) { .typing { display: none; } .typing-static { display: inline; } }
  `);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="title desc">
  <title id="title">${esc(cfg.name)}</title>
  <desc id="desc">${esc(cfg.facts.map((f) => f.text.replace('{age}', age)).join(' · '))}</desc>
  <style>${css}</style>
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#06150c"/><stop offset=".55" stop-color="#0a1f14"/><stop offset="1" stop-color="#0d1117"/>
    </linearGradient>
    <radialGradient id="g1" cx="930" cy="150" r="420" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#2ea043" stop-opacity=".28"/><stop offset="1" stop-color="#2ea043" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="g2" cx="80" cy="400" r="380" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#196c2e" stop-opacity=".25"/><stop offset="1" stop-color="#196c2e" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="nameFill" x1="0" x2="1">
      <stop offset="0" stop-color="#ffffff"/><stop offset=".6" stop-color="#e6ffed"/><stop offset="1" stop-color="#7ee787"/>
    </linearGradient>
    <pattern id="dots" width="22" height="22" patternUnits="userSpaceOnUse"><circle cx="2" cy="2" r="1.1" fill="#7ee787" opacity=".08"/></pattern>
    <clipPath id="frame"><rect width="${W}" height="${H}" rx="24"/></clipPath>
  </defs>
  <g clip-path="url(#frame)">
    <rect width="${W}" height="${H}" fill="url(#bg)"/>
    <rect width="${W}" height="${H}" fill="url(#dots)"/>
    <rect width="${W}" height="${H}" fill="url(#g1)"/>
    <rect width="${W}" height="${H}" fill="url(#g2)"/>
    ${particles}
    ${isoCubes({ ox: 945, oy: 112, s: 31 })}
  </g>
  <rect x=".5" y=".5" width="${W - 1}" height="${H - 1}" rx="24" fill="none" stroke="#1f4a2c"/>

  <text x="${x0}" y="122" class="m fade" font-size="22" fill="#7ee787">${esc(cfg.greeting)}</text>
  <text x="${x0 - 3}" y="196" class="s name" font-size="64" font-weight="800" fill="url(#nameFill)" letter-spacing="-1">${esc(cfg.name)}</text>
  <g class="fade" style="animation-delay:.6s">
    <text x="${x0}" y="${ty}" class="m" font-size="${fs}" font-weight="700" fill="#3fb950">&gt;</text>
    <g class="typing">${typing}${cursor}</g>
    <text x="${tx}" y="${ty}" class="m typing-static" font-size="${fs}" fill="#e6edf3">${esc(cfg.typing[0] ?? '')}</text>
  </g>
  ${pills}
</svg>
`;
}

function renderFooter() {
  const W = 1200, H = 150;
  const wave = (y, amp, len) => {
    let d = `M0 ${y}`;
    for (let x = 0; x < W * 2; x += len) d += ` Q${x + len / 4} ${y - amp} ${x + len / 2} ${y} T${x + len} ${y}`;
    return `${d} V${H} H0 Z`;
  };
  const layers = [
    { y: 82, amp: 14, len: 400, color: '#40c463', op: 0.3, dur: 18 },
    { y: 96, amp: 12, len: 300, color: '#30a14e', op: 0.5, dur: 13 },
    { y: 112, amp: 10, len: 240, color: '#2ea043', op: 0.85, dur: 9 },
  ];
  const css = baseCss(`.wave { animation: wave linear infinite; }
    @keyframes wave { to { transform: translateX(-${W}px); } }`);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Thanks for visiting">
  <style>${css}</style>
  <text x="${W / 2}" y="42" text-anchor="middle" class="s fade" font-size="20" font-weight="600" fill="#2ea043">Thanks for stopping by. Keep building!</text>
  ${layers.map((l) => `<path class="wave" style="animation-duration:${l.dur}s" d="${wave(l.y, l.amp, l.len)}" fill="${l.color}" opacity="${l.op}"/>`).join('\n  ')}
</svg>
`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const config = JSON.parse(await readFile(path.join(ROOT, 'profile.config.json'), 'utf8'));
  await mkdir(path.join(OUT, 'repos'), { recursive: true });
  const write = async (rel, content) => {
    await writeFile(path.join(OUT, rel), content);
    console.log(`  wrote assets/${rel}`);
  };

  await write('header.svg', renderHeader(config));
  await write('footer.svg', renderFooter());

  if (!TOKEN) {
    console.error('GITHUB_TOKEN is not set; skipped the cards that need GitHub data.');
    process.exitCode = 1;
    return;
  }

  const login = config.username;
  const { user, repos } = await fetchProfile(login);
  const days = user.contributionsCollection.contributionCalendar.weeks
    .flatMap((w) => w.contributionDays)
    .map((d) => ({ date: d.date, count: d.contributionCount }));
  const data = {
    login: user.login,
    name: user.name || config.name,
    createdAt: user.createdAt,
    updated: new Date(),
    timezone: config.timezone || 'UTC',
    totalRepos: user.repositories.totalCount,
    stars: repos.reduce((s, r) => s + r.stargazerCount, 0),
    pullRequests: user.pullRequests.totalCount,
    contributions: user.contributionsCollection.contributionCalendar.totalContributions,
    totalCommits: await fetchAllTimeCommits(login, user.createdAt),
    streak: streaks(days),
    languages: aggregateLanguages(repos, config.languages ?? {}),
  };
  const featured = await fetchFeatured(login, config.featured ?? []);

  for (const theme of ['dark', 'light']) {
    await write(`stats-${theme}.svg`, renderStats(data, THEMES[theme]));
    await write(`languages-${theme}.svg`, renderLanguages(data, THEMES[theme]));
    for (const [i, repo] of featured.entries()) {
      await write(`repos/${repo.name}-${theme}.svg`, renderRepo(repo, THEMES[theme], i));
    }
  }

  const { updated, ...snapshot } = data;
  await write('stats.json', `${JSON.stringify({ ...snapshot, updated: updated.toISOString() }, null, 2)}\n`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
