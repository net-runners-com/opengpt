---
description: ChatGPT とこのチャット欄で直接やりとりする（opengpt chat 経由）
argument-hint: <ChatGPTへ送るメッセージ> [--new] [--account <name>]
---

# /openg — ChatGPT と直接やりとり

`$ARGUMENTS` を ChatGPT に送り、**返答だけ**をこのチャット欄に表示する。
`/openg` 専用のスレッドを保持するので、連続して打つと同じ会話が継続する
（他用途のペルソナ会話には混入しない）。`--new` でスレッドをリセット。

## 実行手順（この通りに動くこと）

1. 変数:
   - `REPO=/Users/hirotodev0622i/.superset/projects/opengpt`
   - `AUTH=/Users/hirotodev0622i/.claude/plugins/data/opengpt-skills-dir/auth`
2. `$ARGUMENTS` を解釈する:
   - `--new` があればスレッドをリセット（`chat` に `--new` を渡す）。
   - `--account <name>` があればそのアカウント。無ければ `me`。
   - 残りをメッセージ本文とする。空なら「メッセージを指定してください」とだけ返して終了。
3. 送信する（daemon 常駐で高速化。`--daemon` は無ければ自動起動し、300 秒アイドルで自動終了）:
   ```bash
   cd "$REPO" && OPENGPT_AUTH_DIR="$AUTH" \
     node cli.mjs chat --account <acct> --daemon [--new] "<メッセージ>"
   ```
   - `chat` は `/openg` 専用の会話 id をアカウント別に保存し、次回以降その会話を継続する。
4. 出力ポリシー（重要 — 「直接やりとり」の体験を保つ）:
   - `chat` の標準出力（ChatGPT の返答テキスト）**だけ**を表示する。
   - 自分（Claude）の前置き・要約・解説・感想は付けない。
   - コマンドの実行過程やログは表示しない。
   - エラー時のみ、内容を 1 行で日本語で伝える（例: レート制限中、ログアウト状態）。
5. 会話を続けるかはユーザー次第。こちらから次を促さない。

## メモ
- `chat` は内部で `send` を使うためブラウザ必須（Turnstile / PoW のため純 HTTP 化不可）。daemon が暖まっていれば navigation ~30ms。
- 初回だけ daemon 起動に ~5 秒かかる。以降は高速。
- daemon 常駐中に webtrace 等の別ブラウザを起動しても問題ない（v146 バイナリは同時セッション制限なし・2026-09-18 実測）。
- 現在ログイン済みの web ページを持つのは `me` のみ。他アカウントは要 `login`。
- スレッド状態は `$AUTH/.chat-<account>.json` に保存（`--new` で作り直し）。
