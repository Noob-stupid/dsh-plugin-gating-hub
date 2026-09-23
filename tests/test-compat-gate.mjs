#!/usr/bin/env node
/**
 * 框架升级适配门单元测试：从 lib/index.js 提取纯函数（semver 范围匹配 + 插件兼容判定），
 * 在 vm 沙箱中运行断言。用法：node test-compat-gate.mjs
 */
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const src = fs.readFileSync(path.join(root, 'lib', 'index.js'), 'utf8');
const start = src.indexOf('/** 最小 semver：解析（含 prerelease/build）。 */');
const mid = src.indexOf('/** 读取用户额外 bundle（非官方模板）的补丁插入行 id 与包名，用于"额外插件"判定。 */');
const start2 = src.indexOf('/** 当前运行框架版本（@deepseek-ai/dsh package.json）。 */');
const end = src.indexOf('async function runInstallJob(job, ctx) {');
if (start < 0 || mid < 0 || start2 < 0 || end < 0) { console.error('markers not found', { start, mid, start2, end }); process.exit(1); }
// 切片里若含 `export function`（供其它测试直接调用的辅助函数），vm 沙箱不认 export —— 去掉前缀再执行
const code = (src.slice(start, mid) + '\n' + src.slice(start2, end)).replace(/^export (?=(?:async )?function|const|class)/gmu, '');
const sandbox = { console, Number, String, Object, RegExp, Math, JSON };
vm.createContext(sandbox);
vm.runInContext(code, sandbox);
const { semverRangeMatch, semverRangeMatchLoose, checkPluginFrameworkCompat } = sandbox;
let pass = 0, fail = 0;
function eq(name, got, want) {
  const ok = got === want;
  if (ok) pass++; else { fail++; console.log('FAIL', name, 'got', got, 'want', want); }
}
eq('^0.1.1-rc.2 excludes 0.1.2-rc.1 (npm prerelease rule)', semverRangeMatch('0.1.2-rc.1', '^0.1.1-rc.2'), false);
eq('^0.1.2-rc.1 includes 0.1.2-rc.1', semverRangeMatch('0.1.2-rc.1', '^0.1.2-rc.1'), true);
eq('>=0.1.2 excludes 0.1.2-rc.1 (npm strict, deps)', semverRangeMatch('0.1.2-rc.1', '>=0.1.2'), false);
eq('loose: >=0.1.2 includes 0.1.2-rc.1 (declared)', semverRangeMatchLoose('0.1.2-rc.1', '>=0.1.2'), true);
eq('^0.1.1 includes 0.1.2', semverRangeMatch('0.1.2', '^0.1.1'), true);
eq('^0.1.1 excludes 0.2.0', semverRangeMatch('0.2.0', '^0.1.1'), false);
eq('~1.2.0 includes 1.2.9', semverRangeMatch('1.2.9', '~1.2.0'), true);
eq('~1.2.0 excludes 1.3.0', semverRangeMatch('1.3.0', '~1.2.0'), false);
eq('1.2.3-rc.1 excluded by ^1.2.0', semverRangeMatch('1.2.3-rc.1', '^1.2.0'), false);
eq('^1.2.0 includes 1.9.0', semverRangeMatch('1.9.0', '^1.2.0'), true);
eq('check fail on old dsh-settings range', checkPluginFrameworkCompat({ dependencies: { '@deepseek-ai/dsh-settings': '^0.1.1-rc.2' } }, '0.1.2-rc.1').decision, 'fail');
eq('check unknown when range satisfied', checkPluginFrameworkCompat({ dependencies: { '@deepseek-ai/dsh-settings': '^0.1.2-rc.1' } }, '0.1.2-rc.1').decision, 'unknown');
eq('check pass on declared engines', checkPluginFrameworkCompat({ dsh: { engines: { framework: '>=0.1.2' } } }, '0.1.2-rc.1').decision, 'pass');
eq('check fail on declared engines mismatch', checkPluginFrameworkCompat({ dsh: { engines: { framework: '0.1.1.x' } } }, '0.1.2-rc.1').decision, 'fail');
eq('check unknown on no deps', checkPluginFrameworkCompat({}, '0.1.2-rc.1').decision, 'unknown');
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
