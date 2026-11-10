'use strict';
const fs = require('fs');
const path = require('path');

module.exports = function PlayerTracker(mod) {
  const FILE = path.join(__dirname, 'players.json');
  const SAVE_DELAY = 10000;
  const SWITCH_WINDOW = 90000;
  const PAGE_SIZE = 8;
  const MAX_GROUP = 6;
  const NOTE_MAX = 20;

  const INVISIBLE = /[\u200B-\u200D\u2060\uFEFF]/g;
  const norm = s => String(s == null ? '' : s).replace(INVISIBLE, '').normalize('NFKC').trim().toLocaleLowerCase();
  const clean = s => String(s == null ? '' : s).replace(INVISIBLE, '').normalize('NFC').trim();

  const cfg = { head: true, chat: true };
  const players = new Map();
  const links = new Map();
  const nameToKey = new Map();
  const keyToName = new Map();
  const aliasToKey = new Map();
  const sigGroups = new Map();
  const online = new Map();
  const gone = new Map();

  function groupAdd(sig, k) {
    if (!sig) return;
    let s = sigGroups.get(sig);
    if (!s) {
      s = new Set();
      sigGroups.set(sig, s);
    }
    s.add(k);
  }

  function groupRemove(sig, k) {
    if (!sig) return;
    const s = sigGroups.get(sig);
    if (!s) return;
    s.delete(k);
    if (!s.size) sigGroups.delete(sig);
  }

  try {
    const text = fs.readFileSync(FILE, 'utf8').replace(/^\uFEFF/, '');
    const raw = JSON.parse(text);
    const src = raw.players || raw;
    for (const [k, v] of Object.entries(src)) {
      players.set(k, v);
      if (v.name) {
        keyToName.set(k, v.name);
        nameToKey.set(norm(v.name), k);
      }
      if (v.alias) aliasToKey.set(norm(v.alias), k);
      groupAdd(v.b, k);
    }
    if (raw.links) for (const [k, v] of Object.entries(raw.links)) links.set(k, v);
    if (raw.cfg) Object.assign(cfg, raw.cfg);
  } catch (_) {}

  let timer = null;
  let writing = false;
  let dirty = false;

  const serialize = () => JSON.stringify({
    players: Object.fromEntries(players),
    links: Object.fromEntries(links),
    cfg
  });

  function save() {
    dirty = true;
    if (!timer) timer = setTimeout(flush, SAVE_DELAY);
  }

  async function flush() {
    timer = null;
    if (writing) {
      timer = setTimeout(flush, 1000);
      return;
    }
    writing = true;
    dirty = false;
    try {
      const tmp = FILE + '.tmp';
      await fs.promises.writeFile(tmp, serialize(), 'utf8');
      await fs.promises.rename(tmp, FILE);
    } catch (e) {
      mod.error('Save failed: ' + e.message);
    }
    writing = false;
    if (dirty) save();
  }

  function flushNow() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (!dirty) return;
    try {
      fs.writeFileSync(FILE, serialize(), 'utf8');
      dirty = false;
    } catch (e) {
      mod.error('Save failed: ' + e.message);
    }
  }

  function resetSession() {
    online.clear();
    gone.clear();
  }

  mod.hook('S_RETURN_TO_LOBBY', 'event', () => {
    resetSession();
    flushNow();
  });
  mod.hook('S_EXIT', 'event', flushNow);
  mod.hook('S_LOAD_TOPO', '*', resetSession);
  this.destructor = flushNow;

  const keyOf = (serverId, playerId) => `${serverId}_${playerId}`;
  const pairKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);

  function makeSig(list) {
    if (!Array.isArray(list) || !list.length) return undefined;
    const ids = list.map(x => (x !== null && typeof x === 'object' ? JSON.stringify(x) : String(x)));
    ids.sort();
    return ids.join(',');
  }

  function link(a, b) {
    const pk = pairKey(a, b);
    let l = links.get(pk);
    if (!l) {
      l = { co: 0, sw: 0 };
      links.set(pk, l);
    }
    return l;
  }

  function record(serverId, playerId, name, guild, level, template, benefits) {
    const k = keyOf(serverId, playerId);
    const old = keyToName.get(k);
    if (old && norm(old) !== norm(name) && nameToKey.get(norm(old)) === k) nameToKey.delete(norm(old));
    keyToName.set(k, name);
    nameToKey.set(norm(name), k);

    let p = players.get(k);
    const now = Date.now();
    if (!p) {
      p = { name, f: now };
      players.set(k, p);
    }
    p.name = name;
    p.t = now;
    p.n = (p.n || 0) + 1;
    if (guild) p.g = guild;
    if (level) p.l = level;
    if (template != null) p.c = template;
    const sig = makeSig(benefits);
    if (sig && sig !== p.b) {
      groupRemove(p.b, k);
      p.b = sig;
      groupAdd(sig, k);
    }
    save();
    return k;
  }

  function sigRare(sig) {
    const g = sig ? sigGroups.get(sig) : null;
    return !!g && g.size >= 2 && g.size <= MAX_GROUP;
  }

  function related(p, o) {
    if (p.g && o.g === p.g) return true;
    return !!p.b && p.b === o.b && sigRare(p.b);
  }

  function prune() {
    let removed = false;
    for (const [pk, l] of [...links]) {
      const [a, b] = pk.split('|');
      const pa = players.get(a);
      const pb = players.get(b);
      if (!pa || !pb || (!l.sw && !related(pa, pb))) {
        links.delete(pk);
        removed = true;
      }
    }
    if (removed) save();
  }

  prune();

  function trackSpawn(k, gameId) {
    if (gameId == null) return;
    const p = players.get(k);
    const now = Date.now();
    const already = online.get(gameId) === k;

    if (!already && p) {
      for (const id of online.values()) {
        if (id === k) continue;
        const o = players.get(id);
        if (o && related(p, o)) {
          link(k, id).co++;
          save();
        }
      }
      for (const [gk, info] of gone) {
        if (now - info.at > SWITCH_WINDOW) {
          gone.delete(gk);
          continue;
        }
        const o = players.get(gk);
        if (gk !== k && o && related(p, o)) {
          link(k, gk).sw++;
          save();
        }
      }
    }
    online.set(gameId, k);
  }

  mod.hook('S_DESPAWN_USER', '*', ev => {
    const k = online.get(ev.gameId);
    if (!k) return;
    online.delete(ev.gameId);
    gone.set(k, { at: Date.now() });
  });

  function display(k, realName) {
    const p = players.get(k);
    if (!p) return realName;
    let n = p.alias || realName;
    if (p.main) n += `[${p.main}]`;
    return n;
  }

  const safe = s => clean(s).replace(/[<>&"]/g, '');
  const cut = (s, n) => Array.from(s).slice(0, n).join('');

  function noteTag(k) {
    const p = players.get(k);
    if (!p || !p.note) return '';
    return cut(safe(p.note), NOTE_MAX);
  }

  function headGuild(k, guild) {
    if (!cfg.head) return guild;
    const n = noteTag(k);
    if (!n) return guild;
    return guild ? `${n} | ${guild}` : n;
  }

  function chatName(k, realName) {
    const n = display(k, realName);
    if (!cfg.chat) return n;
    const t = noteTag(k);
    return t ? `${n}(${t})` : n;
  }

  function resolve(input) {
    const l = norm(input);
    return nameToKey.get(l) || aliasToKey.get(l) || null;
  }

  mod.hook('S_SPAWN_USER', '*', { order: -10 }, ev => {
    if (!ev.name) return;
    const k = record(ev.serverId, ev.playerId, ev.name, ev.guildName, ev.level, ev.templateId, ev.accountBenefits);
    trackSpawn(k, ev.gameId);
    const shown = display(k, ev.name);
    const guild = headGuild(k, ev.guildName);
    let changed = false;
    if (shown !== ev.name) {
      ev.name = shown;
      changed = true;
    }
    if (guild !== ev.guildName) {
      ev.guildName = guild;
      changed = true;
    }
    return changed || undefined;
  });

  mod.hook('S_CHAT', '*', { order: -10 }, ev => {
    if (!ev.name) return;
    let k = ev.playerId != null && ev.serverId != null ? keyOf(ev.serverId, ev.playerId) : null;
    if (!k || !players.has(k)) k = nameToKey.get(norm(ev.name));
    if (!k) return;
    const shown = chatName(k, ev.name);
    if (shown !== ev.name) {
      ev.name = shown;
      return true;
    }
  });

  mod.hook('S_WHISPER', '*', { order: -10 }, ev => {
    const field = ev.name !== undefined ? 'name' : 'authorName';
    const real = ev[field];
    if (!real) return;
    const k = nameToKey.get(norm(real));
    if (!k) return;
    const shown = chatName(k, real);
    if (shown !== real) {
      ev[field] = shown;
      return true;
    }
  });

  mod.hook('S_PARTY_MEMBER_LIST', '*', { order: -10 }, ev => {
    let changed = false;
    for (const m of ev.members) {
      if (!m.name) continue;
      const k = record(m.serverId, m.playerId, m.name, null, m.level, undefined, null);
      const shown = display(k, m.name);
      if (shown !== m.name) {
        m.name = shown;
        changed = true;
      }
    }
    return changed || undefined;
  });

  const say = m => mod.command.message(m);

  function entry(k) {
    if (!players.has(k)) players.set(k, { name: keyToName.get(k), f: Date.now(), n: 0 });
    return players.get(k);
  }

  function line(k) {
    const p = players.get(k) || {};
    const parts = [keyToName.get(k) || k];
    if (p.alias) parts.push(`(${p.alias})`);
    if (p.main) parts.push(`[${p.main}]`);
    if (p.g) parts.push(`<${p.g}>`);
    if (p.l) parts.push(`Lv${p.l}`);
    parts.push(`x${p.n || 0}`);
    if (p.note) parts.push(`- ${p.note}`);
    return parts.join(' ');
  }

  function sigWeight(size) {
    if (size < 2 || size > MAX_GROUP) return 0;
    return 6 / (size - 1);
  }

  function pairScore(a, b) {
    const pa = players.get(a);
    const pb = players.get(b);
    if (!pa || !pb) return null;
    const l = links.get(pairKey(a, b)) || { co: 0, sw: 0 };
    let sig = 0;
    let size = 0;
    if (pa.b && pa.b === pb.b) {
      const g = sigGroups.get(pa.b);
      size = g ? g.size : 0;
      sig = sigWeight(size);
    }
    if (!sig && !l.sw) return null;
    let total = sig + l.sw - l.co * 3;
    if (sig && pa.g && pa.g === pb.g) total += 1;
    if (total <= 0) return null;
    return { a, b, total, size, sw: l.sw, co: l.co };
  }

  function suggestions(k) {
    const seen = new Set();
    const out = [];
    const consider = (a, b) => {
      const pk = pairKey(a, b);
      if (seen.has(pk)) return;
      seen.add(pk);
      const r = pairScore(a, b);
      if (r) out.push(r);
    };

    if (k) {
      const p = players.get(k);
      if (p && p.b) {
        const g = sigGroups.get(p.b);
        if (g) for (const o of g) if (o !== k) consider(k, o);
      }
      for (const pk of links.keys()) {
        const [a, b] = pk.split('|');
        if (a === k) consider(a, b);
        else if (b === k) consider(a, b);
      }
    } else {
      for (const g of sigGroups.values()) {
        if (g.size < 2 || g.size > MAX_GROUP) continue;
        const arr = [...g];
        for (let i = 0; i < arr.length; i++) for (let j = i + 1; j < arr.length; j++) consider(arr[i], arr[j]);
      }
      for (const pk of links.keys()) {
        const [a, b] = pk.split('|');
        consider(a, b);
      }
    }
    out.sort((x, y) => y.total - x.total);
    return out;
  }

  mod.command.add('notes', (sub, who, ...rest) => {
    const text = clean(rest.join(' '));

    if (sub === 'list') {
      const page = Math.max(1, parseInt(who, 10) || 1);
      const all = [...players.keys()].sort((a, b) => (players.get(b).t || 0) - (players.get(a).t || 0));
      const pages = Math.max(1, Math.ceil(all.length / PAGE_SIZE));
      const slice = all.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
      say(`${all.length} players | page ${page}/${pages}`);
      for (const k of slice) say(line(k));
      return;
    }

    if (sub === 'find') {
      const q = norm([who, ...rest].filter(Boolean).join(' '));
      if (!q) return say('Usage: !notes find <text>');
      const hits = [];
      for (const [k, p] of players) {
        const hay = norm([p.name, p.alias, p.main, p.note, p.g].filter(Boolean).join(' '));
        if (hay.includes(q)) hits.push(k);
      }
      say(`${hits.length} match(es)`);
      for (const k of hits.slice(0, PAGE_SIZE * 2)) say(line(k));
      return;
    }

    if (sub === 'suggest') {
      const k = who ? resolve(who) : null;
      if (who && !k) return say(`Unknown player "${who}"`);
      const list = suggestions(k).slice(0, PAGE_SIZE);
      if (!list.length) return say('No alt suggestions yet');
      for (const s of list) {
        say(`${keyToName.get(s.a) || s.a} <-> ${keyToName.get(s.b) || s.b} | score ${s.total.toFixed(1)} | benefits group ${s.size || '-'} | switches ${s.sw} | seen together ${s.co}`);
      }
      return;
    }

    if (sub === 'group') {
      const k = who ? resolve(who) : null;
      if (!k) return say('Usage: !notes group <name>');
      const p = players.get(k);
      if (!p || !p.b) return say('No account data for this player');
      const g = sigGroups.get(p.b);
      const names = g ? [...g].map(x => keyToName.get(x) || x) : [];
      return say(`${names.length} player(s) share this account signature: ${names.slice(0, 20).join(', ')}`);
    }

    if (sub === 'alts') {
      const main = norm(who);
      const out = [];
      for (const [kk, p] of players) {
        if (p.main && norm(p.main) === main) out.push(keyToName.get(kk) || kk);
      }
      return say(out.length ? out.join(', ') : 'No known rerolls');
    }

    if (sub === 'head' || sub === 'chat') {
      if (who === 'on' || who === 'off') {
        cfg[sub] = who === 'on';
        save();
      }
      return say(`${sub} notes: ${cfg[sub] ? 'on' : 'off'}`);
    }

    if (sub === 'stats') {
      let withSig = 0;
      for (const p of players.values()) if (p.b) withSig++;
      return say(`${players.size} players | ${withSig} with account data | ${sigGroups.size} signatures | ${links.size} tracked pairs`);
    }

    const k = who ? resolve(who) : null;
    if (who && !k) return say(`Unknown player "${who}"`);

    switch (sub) {
      case 'rename': {
        const e = entry(k);
        if (e.alias) aliasToKey.delete(norm(e.alias));
        e.alias = text || undefined;
        if (text) aliasToKey.set(norm(text), k);
        save();
        say(`Renamed -> ${text || '(removed)'}`);
        break;
      }
      case 'note':
        entry(k).note = text || undefined;
        save();
        say('Note saved (above the head it appears when the player respawns)');
        break;
      case 'alt':
        entry(k).main = text || undefined;
        save();
        say(`${who} is a reroll of ${text || '(removed)'}`);
        break;
      case 'info':
        if (!k) return say('Usage: !notes info <name>');
        say(line(k));
        break;
      case 'forget':
        if (!k) return say('Usage: !notes forget <name>');
        {
          const p = players.get(k);
          if (p) {
            if (p.alias) aliasToKey.delete(norm(p.alias));
            groupRemove(p.b, k);
          }
          nameToKey.delete(norm(keyToName.get(k) || ''));
          keyToName.delete(k);
          players.delete(k);
          for (const pk of [...links.keys()]) {
            const [a, b] = pk.split('|');
            if (a === k || b === k) links.delete(pk);
          }
          save();
          say('Player removed');
        }
        break;
      default:
        say('!notes list [page] | find <text> | suggest [name] | group <name> | stats | head|chat on|off | info|rename|note|alt|forget <name> [text] | alts <main>');
    }
  });
};
