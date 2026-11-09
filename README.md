# ExtensionsUbuntu: свои расширения GNOME Shell

Мои расширения для рабочего ноутбука: Ubuntu 24.04, GNOME Shell 46, Wayland.
На ноутбуке ещё стоят dash-to-panel (панель сверху) и Blur My Shell.
У каждого расширения своя папка, свой `install.sh` и свой подробный README.

| Расширение | Что делает | Клавиши |
|---|---|---|
| [auto-tiling](auto-tiling/README.md) | авто-тайлинг в стиле i3: новое окно делит экран, отступы между окнами, рамка вокруг окна в фокусе, работает с несколькими мониторами; окно не утаскивает на свой стол | Super+стрелки и др. |
| [dropdown-terminal](dropdown-terminal/README.md) | терминал без рамки, выезжает сверху экрана и уезжает той же клавишей; внутри tmux или обычная оболочка | Super+Enter |
| [notification-island](notification-island/README.md) | уведомления «пилюлей» по центру верхней панели, как Dynamic Island | — |
| [screenshot-paste](screenshot-paste/README.md) | скриншот экрана, вставка в чат и Enter одной клавишей | Alt+M |

## Установка

Нужны Ubuntu 24.04 и GNOME 46 на Wayland. Проверить: `gnome-shell --version`.

```bash
cd auto-tiling && ./install.sh            # или dropdown-terminal, notification-island, screenshot-paste
```

Скрипт копирует расширение в `~/.local/share/gnome-shell/extensions/` и включает его.
Потом **выйди из системы и зайди снова**: под Wayland GNOME загружает код
расширения только при входе. Проверить после входа:

```bash
gnome-extensions info auto-tiling@nurik.local   # State: ACTIVE
```

Что важно знать:
- **auto-tiling и Tiling Assistant не уживаются:** оба забирают Super+стрелки.
  `install.sh` выключает Tiling Assistant. В сессии Ubuntu он включается сам,
  если его нет в списке `disabled-extensions`.
- `gnome-extensions disable` кладёт расширение в `disabled-extensions`, и пока оно
  там, расширение не запустится. `install.sh` у auto-tiling, dropdown-terminal и screenshot-paste
  убирает его оттуда, у notification-island включи его командой
  `gnome-extensions enable notification-island@nurik.local`.
- Обновить расширение после правок — тот же `./install.sh` и повторный вход.

## Выключить или удалить

```bash
gnome-extensions disable <uuid>                              # выключить
rm -rf ~/.local/share/gnome-shell/extensions/<uuid>          # удалить совсем
```

`<uuid>` — имя папки расширения: `auto-tiling@nurik.local`, `dropdown-terminal@nurik.local`,
`notification-island@nurik.local`, `screenshot-paste@nurik.local`.

## Проверка без выхода из системы

Автотесты поднимают отдельный GNOME Shell без экрана с временными настройками и
не трогают настоящую сессию.

| Расширение | Как проверить |
|---|---|
| auto-tiling | `node --test auto-tiling/tests/*.test.js` и `./auto-tiling/tests/e2e.sh` (два монитора, клавиши, окна) |
| dropdown-terminal | `./dropdown-terminal/tests/e2e.sh` (два монитора, Super+Enter, tmux и обычная оболочка) |
| screenshot-paste | `./screenshot-paste/tests/e2e.sh` (Alt+M на русской раскладке → вставка и Enter) |
| notification-island | автотестов нет; вложенная сессия и `notify-send`, см. его README |

Тест печатает `OK` или `FAIL` и возвращает код 0 или 1. Ошибки расширения в
логе шелла видны как `JS ERROR`. В живой сессии лог смотри так:

```bash
journalctl -f -o cat /usr/bin/gnome-shell
```

## Как устроен репозиторий

```
ExtensionsUbuntu/
├── README.md                        этот файл
├── auto-tiling/
│   ├── README.md, install.sh
│   ├── tests/                       юнит-тесты дерева, e2e, тестовое окно
│   └── auto-tiling@nurik.local/     само расширение
├── dropdown-terminal/
│   ├── README.md, install.sh
│   ├── tests/                       e2e и тестовое окно
│   └── dropdown-terminal@nurik.local/
├── notification-island/
│   ├── README.md, install.sh
│   ├── notification-banner/         стиль для чужого Notification Banner (необязательно)
│   └── notification-island@nurik.local/
└── screenshot-paste/
    ├── README.md, install.sh
    ├── tests/                       e2e и тестовое окно
    └── screenshot-paste@nurik.local/
```

Новое расширение — новая папка по тому же образцу: `<имя>@nurik.local/` с
`metadata.json` (`"shell-version": ["46"]`), `install.sh`, README и, если можно,
`tests/e2e.sh` по образцу соседних.

## Ветки

- `main` — основная ветка. Правки только через PR, вливаются squash.
- Работа идёт в ветках `feat/…`, `fix/…`, `docs/…`.
