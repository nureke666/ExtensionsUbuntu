# Dropdown Terminal: терминал, который выпадает сверху

Расширение для GNOME Shell. Нажал **Super+Enter**, и сверху экрана появился терминал.
Нажал ещё раз, и он спрятался. Терминал при этом не закрывается: всё, что в нём
запущено, продолжает работать.

Сделано 8 ноября 2026 на Ubuntu 24.04, GNOME Shell 46, Wayland.

Как себя ведёт:
- Первое нажатие запускает отдельный gnome-terminal. Он ставится вверху экрана
  на всю ширину и на 45% высоты, поверх остальных окон и на всех рабочих столах.
- Super+Enter, когда терминал в фокусе, прячет его. Если терминал виден, но
  фокус на другом окне, нажатие выводит его вперёд.
- Спрятанный терминал появляется на том мониторе, где курсор мыши, на текущем
  рабочем столе.
- Закрыл терминал (`exit`) — следующее нажатие откроет новый.
- Новые окна этого терминала (Ctrl+Shift+N) — обычные окна, выпадающим остаётся только первое.
- Если включён auto-tiling и терминал вдруг встал в раскладку, добавь его в
  плавающие: `org.nurik.DropdownTerminal` в `floating-apps` auto-tiling.

## Установка

```bash
cd ~/Projects/ExtensionsUbuntu/dropdown-terminal
./install.sh
```

Потом **выйди из системы и зайди снова**: под Wayland GNOME загружает новое расширение
только при входе. Проверить:

```bash
gnome-extensions info dropdown-terminal@nurik.local   # State: ACTIVE
```

## Настройки

```bash
S="--schemadir $HOME/.local/share/gnome-shell/extensions/dropdown-terminal@nurik.local/schemas"
K=org.gnome.shell.extensions.dropdown-terminal

gsettings $S set $K toggle "['<Super>Return']"   # клавиша
gsettings $S set $K width 100                    # ширина, % экрана
gsettings $S set $K height 45                    # высота, % экрана
gsettings $S set $K hide-on-unfocus true         # прятать, когда кликнул в другое окно
```

Ширина и высота применяются сразу, клавиша тоже.

Другой терминал: в `command` — команда, которая даёт окну свой app id, в `app-id` — этот id.
По умолчанию:

```bash
gsettings $S set $K command "['gnome-terminal', '--app-id', 'org.nurik.DropdownTerminal']"
gsettings $S set $K app-id 'org.nurik.DropdownTerminal'
```

`--app-id` у gnome-terminal в Ubuntu запускает отдельный сервер терминала, поэтому
выпадающий терминал не смешивается с обычными окнами gnome-terminal.

## Выключить или удалить

```bash
gnome-extensions disable dropdown-terminal@nurik.local
rm -rf ~/.local/share/gnome-shell/extensions/dropdown-terminal@nurik.local   # удалить совсем
```

Сам терминал при выключении не закрывается и становится обычным окном.

## Как устроено

```
dropdown-terminal/
├── README.md
├── install.sh
├── tests/
│   ├── e2e.sh                       проверка в фоновом GNOME Shell с двумя мониторами
│   └── win.py                       тестовое окно, чтобы увести фокус
└── dropdown-terminal@nurik.local/
    ├── metadata.json                GNOME 46
    ├── extension.js                 вся логика
    └── schemas/                     настройки: клавиша, команда, app id, размер
```

- Терминал — обычное окно приложения. Расширение только запускает его, прячет
  (сворачивает), показывает и ставит на место.
- Своё окно оно узнаёт по app id. Под Wayland id приходит уже после создания окна,
  поэтому окно берётся в работу после первого кадра, а настраивается в idle:
  `make_above()` прямо во время отрисовки кадра роняет mutter.
- После выключения и включения (блокировка экрана, перезапуск расширения) уже
  открытый терминал подхватывается, второй не запускается.

## Проверка без выхода из системы

```bash
./tests/e2e.sh            # OK или FAIL с окнами
VERBOSE=1 ./tests/e2e.sh  # то же, со временем каждой проверки
```

Скрипт запускает отдельный GNOME Shell без окна (`--headless`) с двумя мониторами
и настоящим gnome-terminal. Жмёт Super+Enter виртуальной клавиатурой и проверяет:
- терминал наверху, поверх окон и на всех столах;
- прячется и показывается;
- появляется на текущем столе и на мониторе с курсором;
- выходит вперёд, если фокус на другом окне;
- `hide-on-unfocus` работает;
- после закрытия открывается новый;
- после перезапуска расширения подхватывается старый;
- в логе шелла нет `JS ERROR` и ошибок mutter.

Настоящую сессию тест не трогает: у него свои D-Bus, настройки и runtime-папка.
Там же отключены портал, gvfs и шина accessibility, без них GTK-приложения
стартуют по 25 секунд.
