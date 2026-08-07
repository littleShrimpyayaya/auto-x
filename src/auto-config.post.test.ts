/**
 * Unit tests for PostConfig v2 migrate / mirror / lift / updatePostConfig.
 * Run: npx tsx --test src/auto-config.post.test.ts
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';

// Point config at a temp dir by monkey-patching process.cwd via chdir
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-x-post-'));
const dataDir = path.join(tmpRoot, 'data');
fs.mkdirSync(dataDir, { recursive: true });
const origCwd = process.cwd();

beforeEach(() => {
  process.chdir(tmpRoot);
  // clean config
  const cfg = path.join(dataDir, 'config.json');
  if (fs.existsSync(cfg)) fs.unlinkSync(cfg);
  if (fs.existsSync(cfg + '.bak')) fs.unlinkSync(cfg + '.bak');
});

afterEach(() => {
  process.chdir(origCwd);
});

// Dynamic import after chdir so CONFIG_DIR resolves under tmpRoot
async function loadMod() {
  // Bust cache so each suite gets fresh module state for lock — use query? no, node caches by path.
  // Module is fine; lock is in-module. Re-import same module.
  return import('./auto-config.js');
}

describe('PostConfig v2', () => {
  it('migrates v1 → v2 with COMPOSER_TASK_ID and dual-write', async () => {
    const m = await loadMod();
    const v1 = {
      templates: ['hello world'],
      autoPostEnabled: true,
      autoPostIntervalMinutes: 30,
      autoPostTemplateIndex: 0,
      lastPostAt: '2026-01-01T00:00:00.000Z',
      postAutoIndex: 3,
    };
    fs.writeFileSync(
      path.join(dataDir, 'config.json'),
      JSON.stringify({ automation: { authToken: 'keep-me' }, post: v1 }, null, 2),
    );
    const cfg = m.loadPostConfig();
    assert.equal(cfg.version, 2);
    assert.equal(cfg.tasks.length, 1);
    assert.equal(cfg.tasks[0].id, m.COMPOSER_TASK_ID);
    assert.equal(cfg.tasks[0].content, 'hello world');
    assert.equal(cfg.tasks[0].enabled, true);
    assert.equal(cfg.tasks[0].intervalMinutes, 30);
    assert.equal(cfg.tasks[0].lastPostAt, '2026-01-01T00:00:00.000Z');
    assert.equal(cfg.autoPostEnabled, true);
    assert.equal(cfg.templates[0], 'hello world');
    // automation preserved
    const root = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf-8'));
    assert.equal(root.automation.authToken, 'keep-me');
    assert.equal(root.post.version, 2);
    assert.ok(fs.existsSync(path.join(dataDir, 'config.json.bak')));
  });

  it('U1: updatePostConfig composer-first updates both sides lastPostAt', async () => {
    const m = await loadMod();
    await m.updatePostConfig((cfg) => {
      return m.ensureComposerTask(cfg, {
        content: 'c1',
        enabled: true,
        intervalMinutes: 15,
      });
    });
    const after = await m.updatePostConfig((cfg) => {
      const t = cfg.tasks.find((x) => x.id === m.COMPOSER_TASK_ID)!;
      t.lastPostAt = '2026-08-07T12:00:00.000Z';
      t.postCount = 1;
    });
    assert.equal(after.lastPostAt, '2026-08-07T12:00:00.000Z');
    assert.equal(after.tasks[0].lastPostAt, '2026-08-07T12:00:00.000Z');
  });

  it('U2: savePostConfig (deprecated) lifts legacy then mirrors', async () => {
    const m = await loadMod();
    // seed composer
    await m.updatePostConfig((cfg) =>
      m.ensureComposerTask(cfg, { content: 'old', enabled: false, intervalMinutes: 60 }),
    );
    // legacy-style write
    m.savePostConfig({
      version: 2,
      tasks: [],
      ai: m.DEFAULT_POST_AI,
      templates: ['from-legacy'],
      autoPostEnabled: true,
      autoPostIntervalMinutes: 20,
      autoPostTemplateIndex: 0,
      lastPostAt: '2026-08-07T13:00:00.000Z',
      postAutoIndex: 9,
    });
    const cfg = m.loadPostConfig();
    const c = m.getComposerTask(cfg)!;
    assert.equal(c.content, 'from-legacy');
    assert.equal(c.enabled, true);
    assert.equal(c.intervalMinutes, 20);
    assert.equal(c.lastPostAt, '2026-08-07T13:00:00.000Z');
    assert.equal(cfg.autoPostEnabled, true);
    assert.equal(cfg.lastPostAt, '2026-08-07T13:00:00.000Z');
  });

  it('U3: updatePostConfig does not lift stale legacy over composer mutator', async () => {
    const m = await loadMod();
    await m.updatePostConfig((cfg) =>
      m.ensureComposerTask(cfg, { content: 'composer-text', enabled: true, intervalMinutes: 10 }),
    );
    // Manually poison legacy fields on disk without going through lift path
    const root = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf-8'));
    root.post.templates = ['STALE_LEGACY'];
    root.post.autoPostEnabled = false;
    root.post.lastPostAt = '1999-01-01T00:00:00.000Z';
    // leave tasks[composer].content as composer-text
    fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify(root, null, 2));

    const after = await m.updatePostConfig((cfg) => {
      const t = cfg.tasks.find((x) => x.id === m.COMPOSER_TASK_ID)!;
      t.lastPostAt = '2026-08-07T14:00:00.000Z';
      t.content = 'composer-text';
      t.enabled = true;
    });
    // mirror should re-sync from composer, not keep STALE as truth for content after mutator
    assert.equal(after.tasks.find((t) => t.id === m.COMPOSER_TASK_ID)!.lastPostAt, '2026-08-07T14:00:00.000Z');
    assert.equal(after.lastPostAt, '2026-08-07T14:00:00.000Z');
    assert.equal(after.templates[0], 'composer-text');
    assert.equal(after.autoPostEnabled, true);
  });

  it('U4: atomic save preserves automation', async () => {
    const m = await loadMod();
    fs.writeFileSync(
      path.join(dataDir, 'config.json'),
      JSON.stringify(
        {
          automation: {
            authToken: 'tok',
            ct0: 'ct0',
            followBackAutoEnabled: true,
            activeHoursStart: 9,
          },
          post: {
            templates: ['x'],
            autoPostEnabled: false,
            autoPostIntervalMinutes: 60,
            autoPostTemplateIndex: 0,
            lastPostAt: null,
            postAutoIndex: 0,
          },
        },
        null,
        2,
      ),
    );
    m.loadPostConfig(); // migrate
    await m.updatePostConfig((cfg) =>
      m.ensureComposerTask(cfg, { content: 'y', enabled: false }),
    );
    const root = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf-8'));
    assert.equal(root.automation.authToken, 'tok');
    assert.equal(root.automation.ct0, 'ct0');
    assert.equal(root.automation.followBackAutoEnabled, true);
    assert.equal(root.automation.activeHoursStart, 9);
  });

  it('clampTweetBody respects suffix length', async () => {
    const m = await loadMod();
    const suffix = m.antiDupeSuffix(new Date('2026-08-07T04:00:00.000Z'), 'Asia/Shanghai');
    const body = 'a'.repeat(300);
    const clamped = m.clampTweetBody(body, suffix, 280);
    assert.ok(Array.from(clamped + suffix).length <= 280);
  });
});
