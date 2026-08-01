import * as path from 'node:path';
import { kbDir, listJsonFiles, newId, nowIso, readJson, writeJson } from '../core/storage';
import type { SettingEntry, SettingCategory, StyleEntry, TemplateEntry } from './types';
import { categoryLabel } from './types';

type Kind = 'styles' | 'settings' | 'templates';

function dirOf(kind: Kind): string {
  return kbDir(kind);
}

function readEntry<T>(kind: Kind, id: string, fallback: T): T {
  return readJson<T>(path.join(dirOf(kind), id + '.json'), fallback);
}

function writeEntry(kind: Kind, entry: unknown): void {
  const e = entry as { id: string };
  writeJson(path.join(dirOf(kind), e.id + '.json'), entry);
}

export interface KbService {
  listStyles(): StyleEntry[];
  findStyle(id: string): StyleEntry | null;
  saveStyle(entry: StyleEntry): void;
  removeStyle(id: string): void;
  listSettings(): SettingEntry[];
  findSetting(id: string): SettingEntry | null;
  saveSetting(entry: SettingEntry): void;
  removeSetting(id: string): void;
  listTemplates(): TemplateEntry[];
  findTemplate(id: string): TemplateEntry | null;
  saveTemplate(entry: TemplateEntry): void;
  removeTemplate(id: string): void;
  search<T extends { id: string; name: string; tags: string[] }>(kind: Kind, keyword: string): T[];
  stats(): { styles: number; settings: number; templates: number };
}

export function createKbService(): KbService {
  return {
    listStyles(): StyleEntry[] {
      return listJsonFiles(dirOf('styles'))
        .map((f) => readJson<StyleEntry>(path.join(dirOf('styles'), f), {} as StyleEntry))
        .filter((e) => (e as { deleted?: boolean }).deleted !== true);
    },
    findStyle(id) {
      return readJson<StyleEntry | null>(path.join(dirOf('styles'), id + '.json'), null);
    },
    saveStyle(entry) {
      writeEntry('styles', entry);
    },
    removeStyle(id) {
      // 留痕：保留原内容，标记 deleted（可手动恢复）
      const existing = readJson<StyleEntry | null>(path.join(dirOf('styles'), id + '.json'), null);
      writeJson(path.join(dirOf('styles'), id + '.json'), { ...(existing ?? { id }), deleted: true });
    },
    listSettings(): SettingEntry[] {
      return listJsonFiles(dirOf('settings'))
        .map((f) => readJson<SettingEntry>(path.join(dirOf('settings'), f), {} as SettingEntry))
        .filter((e) => (e as { deleted?: boolean }).deleted !== true);
    },
    findSetting(id) {
      return readJson<SettingEntry | null>(path.join(dirOf('settings'), id + '.json'), null);
    },
    saveSetting(entry) {
      writeEntry('settings', entry);
    },
    removeSetting(id) {
      const existing = readJson<SettingEntry | null>(path.join(dirOf('settings'), id + '.json'), null);
      writeJson(path.join(dirOf('settings'), id + '.json'), { ...(existing ?? { id }), deleted: true });
    },
    listTemplates(): TemplateEntry[] {
      return listJsonFiles(dirOf('templates'))
        .map((f) => readJson<TemplateEntry>(path.join(dirOf('templates'), f), {} as TemplateEntry))
        .filter((e) => (e as { deleted?: boolean }).deleted !== true);
    },
    findTemplate(id) {
      return readJson<TemplateEntry | null>(path.join(dirOf('templates'), id + '.json'), null);
    },
    saveTemplate(entry) {
      writeEntry('templates', entry);
    },
    removeTemplate(id) {
      const existing = readJson<TemplateEntry | null>(path.join(dirOf('templates'), id + '.json'), null);
      writeJson(path.join(dirOf('templates'), id + '.json'), { ...(existing ?? { id }), deleted: true });
    },
    search<T extends { id: string; name: string; tags: string[] }>(kind: Kind, keyword: string): T[] {
      const k = keyword.trim().toLowerCase();
      if (!k) return [] as T[];
      const all = (() => {
        switch (kind) {
          case 'styles': return this.listStyles();
          case 'settings': return this.listSettings();
          case 'templates': return this.listTemplates();
        }
      })() as unknown as T[];
      return all.filter(
        (e) =>
          e.name.toLowerCase().includes(k) ||
          (e.tags ?? []).some((t) => t.toLowerCase().includes(k))
      );
    },
    stats() {
      return {
        styles: this.listStyles().length,
        settings: this.listSettings().length,
        templates: this.listTemplates().length,
      };
    },
  };
}

export function newStyle(partial: Partial<StyleEntry>): StyleEntry {
  const now = nowIso();
  return {
    id: newId('style'),
    name: partial.name ?? '未命名风格',
    description: partial.description ?? '',
    rules: partial.rules ?? [],
    exampleText: partial.exampleText ?? '',
    tags: partial.tags ?? [],
    source: partial.source ?? 'manual',
    createdAt: partial.createdAt ?? now,
    updatedAt: now,
  };
}

export function newSetting(partial: Partial<SettingEntry>): SettingEntry {
  const now = nowIso();
  return {
    id: newId('set'),
    name: partial.name ?? '未命名设定',
    category: partial.category ?? 'other',
    content: partial.content ?? '',
    facts: partial.facts ?? [],
    aliases: partial.aliases ?? [],
    tags: partial.tags ?? [],
    source: partial.source ?? 'manual',
    createdAt: partial.createdAt ?? now,
    updatedAt: now,
  };
}

export function newTemplate(partial: Partial<TemplateEntry>): TemplateEntry {
  const now = nowIso();
  return {
    id: newId('tpl'),
    name: partial.name ?? '未命名模板',
    purpose: partial.purpose ?? '',
    prompt: partial.prompt ?? '',
    tags: partial.tags ?? [],
    createdAt: partial.createdAt ?? now,
    updatedAt: now,
  };
}

export function describeSetting(s: SettingEntry): string {
  const facts = s.facts.length ? ` | 事实(${s.facts.length})` : '';
  return `[${categoryLabel(s.category)}] ${s.name} —— ${s.content.slice(0, 40)}${facts}`;
}
