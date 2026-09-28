# dsh.so L4 安装实测报告 — dsh-plugin-hub

## 验证环境
- 平台：Windows x64
- Node：v24.13.0
- DSH：`@deepseek-ai/dsh@0.1.1-rc.2`
- 插件：`@noob-stupid/dsh-plugin-console@0.3.20`
- 隔离 DSH_HOME：`C:\work\.testdir\dshso-l4`
- profile：web（仅官方 base + web-app + 本插件）

## 安装步骤（在隔离环境执行）
```sh
DSH_HOME=C:\work\.testdir\dshso-l4 \
node .../@deepseek-ai/dsh/lib/bin.js plugin --profile web add @noob-stupid/dsh-plugin-console@0.3.20
```

结果：
```
Packages: +1
added @noob-stupid/dsh-plugin-console@0.3.20
Done in 2.9s using pnpm v11.21.0
```

## 配置解析验证
```sh
DSH_HOME=C:\work\.testdir\dshso-l4 \
node .../@deepseek-ai/dsh/lib/bin.js --profile web --dump-config
```

输出尾部确认：
```yaml
# == @noob-stupid/dsh-plugin-console
- id: plugin-console
  name: '@noob-stupid/dsh-plugin-console'
```

说明：
- bundle 能正确解析；
- 插件已进入 DSH profile 配置树；
- 无依赖缺失/解析错误。

## 运行验证（真实环境）
- DSH 服务运行中：`http://127.0.0.1:3080`
- `GET /plugin-console/state` 返回：
  ```json
  { "ok": true, "entries": 193, "selfVersion": "0.3.20" }
  ```
- 插件加载为 active。

## 结论
- ✅ L4（install tested）：隔离环境安装成功、无依赖错误；
- ✅ L5（run tested 组件）：插件被 DSH 加载并进入可运行配置树。
