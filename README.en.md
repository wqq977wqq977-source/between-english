# 句。间 Between

[简体中文](README.md) · English

*Words into worlds.*

Learn English through things you want to read. Find vocabulary and real articles with Codex, ask questions as you read, and build a record of your progress.

[Quick start](#quick-start) · [User guide](docs/usage.md) · [Configuration](docs/configuration.md)

![Between: the original English article on the left, explanations and questions on the right](docs/images/reading-preview.jpg)

*Reading workspace with sample article and explanation content. The app interface and detailed guides are currently in Simplified Chinese.*

## A little, every day

| Start with | What you can do |
| --- | --- |
| **Curate** | Describe an interest, choose a quantity and approximate difficulty, and send the results to your word lists and reading library. |
| **Practice** | Study with cards, spelling and spaced review. Save unfamiliar words and search your lists. |
| **Read** | Read the original alongside explanations grounded in the article and selected sentences. Translate, ask questions, take comprehension quizzes, or import your own text. |
| **Reflect** | View Daily / Weekly activity and let learning memory inform suggested directions. |

Discover available models in Settings, with separate Effort / Fast controls for retrieval and the reading assistant. The reading assistant also supports custom OpenAI-compatible Chat Completions APIs.

## Quick start

You need **Node.js 22.13+ (24 recommended)** and npm. macOS and Linux are supported; native Windows has not been verified.

```sh
git clone https://github.com/wqq977wqq977-source/between-english.git
cd between-english
npm ci
npm start
```

Open [http://127.0.0.1:4318](http://127.0.0.1:4318). Press `Ctrl+C` in the terminal to stop the server.

**Enable retrieval:** Install Codex CLI, run `codex login` in another terminal, then fetch models in Settings. The website can start before you sign in; vocabulary and article retrieval require a working Codex account. Custom APIs serve the reading assistant only. See [API configuration](docs/configuration.md#自定义-api) and [Codex compatibility](docs/configuration.md#codex-与模型选择).

**macOS:** You can also double-click [`start.command`](start.command) to start the server in the background and open the app. See [startup options](docs/configuration.md#启动方式).

## Your learning space

- Vocabulary, articles and progress are stored in local SQLite. Notes and learning summaries are stored in `memroy.md`, created on first launch.
- Activity recording and personalization are enabled by default and can be disabled independently in Settings. Model requests include the text and questions needed for the task, plus relevant memory summaries when personalization is enabled.
- Codex uses your CLI account's allowance; custom APIs use the selected provider's account. The server listens on loopback only and is intended for one local user.

Default data paths, personal memory, credentials and logs are excluded from Git. See [configuration and backups](docs/configuration.md) for storage locations and model boundaries.

## Development

Plain JavaScript / CSS, Node HTTP / SQLite, with no frontend build step. Article extraction uses Readability and LinkeDOM.

```sh
npm run dev    # Restart the backend when its files change
npm run check
npm test
```

Tests use temporary data and mock services. No model credentials are required.

[Contributing](CONTRIBUTING.md) · [Security and data handling](SECURITY.md)

## License

[MIT](LICENSE) © 2026 WQQ977. Dependencies retain their own licenses; see [third-party notices](THIRD_PARTY_NOTICES.md). Articles retrieved online or imported by users are outside this project's software license.
