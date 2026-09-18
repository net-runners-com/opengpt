---
description: ChatGPT と直接やりとり（opengpt chat・専用スレッド自動継続。--new でリセット）
argument-hint: <メッセージ> [--new]
---
`$ARGUMENTS` から `--new` があれば分離し、残りをメッセージとして下記を実行する。
**ChatGPT の返答（標準出力）だけ**を表示する — 前置き・要約・解説は付けない。エラー時のみ日本語1行。

```bash
cd /Users/hirotodev0622i/.superset/projects/opengpt && \
OPENGPT_AUTH_DIR=/Users/hirotodev0622i/.claude/plugins/data/opengpt-skills-dir/auth \
node cli.mjs chat --account me --daemon [--new] "<メッセージ>"
```
