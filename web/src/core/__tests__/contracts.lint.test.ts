/// <reference types="node" />
/** Core rules (§11.3b): `.ts` import suffixes, `import type` for type-only imports, no npm deps / DOM / Phaser /
 * JSON imports, node:* only in Node-only files, and the core tsconfig flags. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { lintSource } from '../util/lint.ts';
import { CORE_DIR, coreSourceFiles } from './helpers.ts';

describe('core lint', () => {
  it('source rules hold for every core file', () => {
    const issues = coreSourceFiles().flatMap((f) => lintSource(f, readFileSync(join(CORE_DIR, f), 'utf8')));
    expect(issues.map((i) => `${i.file}:${i.line} ${i.rule}`)).toEqual([]);
  });

  it('lint catches what it should', () => {
    const FROM = 'fr' + 'om'; // split so this file does not lint itself
    const bad = [
      `import { x } ${FROM} './a';`,
      `import x ${FROM} './data.json';`,
      `import Phaser ${FROM} 'phaser';`,
      `import { z } ${FROM} 'zod';`,
      `import { readFileSync } ${FROM} 'node:fs';`,
      'const el = document' + '.createElement("div");',
    ].join('\n');
    expect(lintSource('build/x.ts', bad).map((i) => i.rule)).toEqual([
      'ts-suffix', 'no-json-import', 'no-phaser', 'no-npm-deps', 'node-only', 'no-dom',
    ]);
  });

  it('type-only imports use `import type`', () => {
    const cfgPath = join(CORE_DIR, 'tsconfig.json');
    const cfg = ts.getParsedCommandLineOfConfigFile(cfgPath, {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} });
    expect(cfg).toBeDefined();
    const program = ts.createProgram(cfg!.fileNames, cfg!.options);
    const checker = program.getTypeChecker();
    const bad: string[] = [];
    for (const sf of program.getSourceFiles()) {
      if (!sf.fileName.startsWith(CORE_DIR) || sf.fileName.endsWith('types.gen.ts')) continue;
      for (const st of sf.statements) {
        if (!ts.isImportDeclaration(st) || st.importClause?.isTypeOnly) continue;
        const nb = st.importClause?.namedBindings;
        if (!nb || !ts.isNamedImports(nb)) continue;
        for (const el of nb.elements) {
          if (el.isTypeOnly) continue;
          const sym = checker.getSymbolAtLocation(el.name);
          if (!sym) continue;
          const target = sym.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(sym) : sym;
          if (!(target.flags & ts.SymbolFlags.Value)) bad.push(`${sf.fileName.slice(CORE_DIR.length + 1)}: ${el.name.text}`);
        }
      }
    }
    expect(bad).toEqual([]);
  }, 60_000);

  it('core tsconfig enforces erasable syntax and explicit .ts imports', () => {
    const raw = ts.parseConfigFileTextToJson('tsconfig.json', readFileSync(join(CORE_DIR, 'tsconfig.json'), 'utf8')).config;
    const o = raw.compilerOptions;
    expect(o.erasableSyntaxOnly).toBe(true);
    expect(o.verbatimModuleSyntax).toBe(true);
    expect(o.allowImportingTsExtensions).toBe(true);
    expect(o.noEmit).toBe(true);
    expect(o.lib).toEqual(['ES2022']);
  });
});
