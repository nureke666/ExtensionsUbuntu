# Screenshot Paste: скриншот в чат одной клавишей

Расширение для GNOME Shell. Нажал **Alt+M** — и оно само:

1. делает скриншот всего экрана (все мониторы, без курсора мыши);
2. кладёт его в буфер обмена и вставляет (Ctrl+V) туда, где мигает курсор ввода;
3. через 0,5 с нажимает Enter — в Telegram, Slack, ChatGPT и т. п. это отправка.

Сделано 6 ноября 2026 на Ubuntu 24.04, GNOME Shell 46, Wayland.

Что важно знать:
- Ctrl+V и Enter нажимаются, когда ты отпустишь Alt. Держишь Alt дольше 3 секунд —
  вставки не будет, скриншот просто останется в буфере.
- Скриншот заменяет то, что было в буфере обмена.
- Работает при любой раскладке, в том числе русской.
- Клавиши уходят в окно в фокусе. Если там нет поля ввода, картинка никуда не вставится,
  а Enter всё равно нажмётся.

## Установка

```bash
cd ~/Projects/ExtensionsUbuntu/screenshot-paste
./install.sh
```

Потом **выйди из системы и зайди снова**: под Wayland GNOME загружает новое расширение
только при входе. Проверить:

```bash
gnome-extensions info screenshot-paste@nurik.local   # State: ACTIVE
```

## Настройки

```bash
S="--schemadir $HOME/.local/share/gnome-shell/extensions/screenshot-paste@nurik.local/schemas"
K=org.gnome.shell.extensions.screenshot-paste

gsettings $S set $K paste-screenshot "['<Alt>m']"   # сочетание клавиш
gsettings $S set $K enter-delay 500                 # пауза между Ctrl+V и Enter, мс
```

Если Enter срабатывает раньше, чем приложение успело принять картинку (например,
Telegram ещё не открыл окно «Отправить фото»), увеличь `enter-delay` до 800–1000.

## Выключить или удалить

```bash
gnome-extensions disable screenshot-paste@nurik.local
rm -rf ~/.local/share/gnome-shell/extensions/screenshot-paste@nurik.local   # удалить совсем
```

## Как устроено

```
screenshot-paste/
├── README.md
├── install.sh
├── tests/
│   ├── e2e.sh                   проверка в фоновом GNOME Shell
│   └── target.py                тестовое окно: пишет, что в него вставили
└── screenshot-paste@nurik.local/
    ├── metadata.json            GNOME 46
    ├── extension.js             вся логика
    └── schemas/                 настройки: клавиша и пауза перед Enter
```

- Скриншот — `Shell.Screenshot` прямо в процессе шелла, без вспышки и звука.
- В буфер он кладётся как `image/png` через `St.Clipboard`, так же делает штатный
  скриншот GNOME.
- Ctrl+V и Enter нажимает виртуальная клавиатура Clutter. Клавиши задаются кодами
  evdev, а не символами: при русской раскладке символа `v` нет, а код клавиши тот же.

## Проверка без выхода из системы

```bash
./tests/e2e.sh
```

Скрипт запускает отдельный GNOME Shell без окна (`--headless`) с копией расширения и
русской раскладкой. Открывает тестовое окно, нажимает Alt+M виртуальной клавиатурой и
отпускает Alt через 300 мс. Потом проверяет, что окно получило картинку, после неё
Enter, и что в логе шелла нет `JS ERROR`. Настоящую сессию не трогает. В конце пишет
`OK` или `FAIL`.
