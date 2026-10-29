# Notification Island: уведомления пилюлей в верхней панели

Своё расширение для GNOME Shell. Вместо обычного баннера уведомление показывается
чёрной «пилюлей» по центру верхней панели, как Dynamic Island на айфоне.

Сделано и проверено 8 октября 2026 на Ubuntu 24.04, GNOME Shell 46, Wayland,
с dash-to-panel (панель сверху, высота 32 px) и Blur My Shell.

## Что получилось

- Уведомление от любого приложения (Telegram, Chrome, системные) появляется
  пилюлей в центре верхней панели: иконка, жирное имя/заголовок и текст в одну строку.
- Пилюля «вырастает» из центра и сама исчезает через 5 секунд. Пока курсор на
  ней, она не исчезает.
- Длинный текст обрезается многоточием, пилюля не шире 460 px.
- Клик по пилюле открывает уведомление в приложении (в Telegram открывается чат).
- Новое уведомление сразу заменяет текущее, очереди нет.
- Как и раньше, работают «Не беспокоить», отключение баннеров для отдельного
  приложения в «Параметры → Уведомления» и отсутствие всплывашек поверх окна
  на весь экран.
- Критические уведомления (низкий заряд и т.п.) идут обычным баннером GNOME:
  в них бывают кнопки, а пилюля кнопок не показывает.
- Уведомления с низкой важностью всплывашкой не показываются (так было и в
  обычном GNOME), они только попадают в список у часов.
- Все уведомления, как и раньше, остаются в списке у часов.

## Почему именно так

1. **Telegram Desktop.** Официальная сборка из `/opt/Telegram`. Под Wayland
   Telegram всегда отдаёт уведомления системе и прячет в настройках выбор угла
   и количества: Wayland не даёт программам самим двигать свои окна. Вернуть эти
   настройки можно только запуском через X11 (`QT_QPA_PLATFORM=xcb /opt/Telegram/Telegram`),
   но тогда при дробном масштабе интерфейс может стать мыльным. От этого варианта отказались.
2. **Расширение Notification Banner** (`notification-banner@VitalyOstanin`) умеет
   двигать системный баннер в любой угол и менять его ширину и шрифт. Но ширина
   и шрифт не применялись: **Blur My Shell** ставит баннеру скругление через
   inline-стиль и стирает inline-стиль Notification Banner. Обошли через файл
   `stylesheet.css` (см. раздел «Необязательно» ниже).
3. Notification Banner умеет ставить баннер только **под** панелью, а нужно было
   **в** панели, как на айфоне. Готового расширения для GNOME 46 не нашлось, поэтому
   написали своё: Notification Island.

## Установка (новый ноутбук или после сброса)

Нужны Ubuntu 24.04 с GNOME 46 на Wayland. Проверить версию: `gnome-shell --version`.
Если версия другая, сначала прочитай раздел «Другая версия GNOME».

```bash
cd ~/Projects/ExtensionsUbuntu/notification-island
./install.sh
```

Затем **выйди из системы и зайди снова**: на Wayland GNOME подхватывает новые
расширения только при входе.

Проверить после входа:

```bash
gnome-extensions info notification-island@nurik.local   # должно быть State: ACTIVE
notify-send "Тест" "Привет"                              # пилюля в центре панели
```

### Установка вручную, без скрипта

```bash
mkdir -p ~/.local/share/gnome-shell/extensions/notification-island@nurik.local
cp notification-island@nurik.local/* ~/.local/share/gnome-shell/extensions/notification-island@nurik.local/
```

Выйди из системы и зайди снова, потом включи расширение командой
`gnome-extensions enable notification-island@nurik.local` или в Extension Manager.

## Настройка внешнего вида

Внешний вид задаётся в `stylesheet.css`:

| Что | Свойство | Сейчас |
|---|---|---|
| Цвет фона пилюли | `.notification-island` → `background-color` | `#000` |
| Цвет фона при наведении | `.notification-island:hover` → `background-color` | `#1c1c1c` |
| Максимальная ширина | `.notification-island` → `max-width` | `460px` |
| Минимальная ширина | `.notification-island` → `min-width` | `140px` |
| Размер шрифта | `.notification-island` → `font-size` | `10pt` |
| Размер иконки | `.notification-island-icon` → `icon-size` | `20px` |
| Максимальная ширина имени | `.notification-island-title` → `max-width` | `170px` |
| Цвет текста сообщения | `.notification-island-body` → `color` | `#b5b5b5` |

Время показа и анимация задаются константами в начале `extension.js`:

- `SHOW_TIME_MS = 5000`: сколько миллисекунд пилюля висит;
- `HOVER_LEAVE_TIME_MS = 2000`: сколько она ещё висит после того, как ушёл курсор;
- `SHOW_ANIMATION_MS` и `HIDE_ANIMATION_MS`: длительность анимаций;
- `PANEL_INSET = 3`: отступ пилюли от верхнего и нижнего края панели.

Высота пилюли подстраивается под высоту верхней панели автоматически. Если
верхней панели нет, пилюля рисуется у верхнего края экрана, высотой 30 px.

После правок скопируй файлы заново (`./install.sh`), потом выйди из системы и
зайди снова. Под Wayland GNOME перечитывает код расширения только при входе.

## Как это устроено

- В GNOME за всплывашки отвечает `MessageTray` (`/org/gnome/shell/ui/messageTray.js`
  внутри `/usr/lib/gnome-shell/libshell-14.so`). Он сам решает, можно ли сейчас
  показать уведомление («Не беспокоить», настройки приложения, полный экран), и
  вызывает `_showNotification()`.
- Расширение подменяет `_showNotification()`: берёт уведомление из очереди
  `_notificationQueue` и показывает его в пилюле. Для критических уведомлений
  вызывается обычный `_showNotification()`.
- Пилюля добавляется поверх всего интерфейса (`addTopChrome`) и ставится по
  центру основного монитора. Высота верхней панели берётся из рабочей области
  монитора, поэтому это работает и с обычной панелью, и с dash-to-panel.
- При показе уведомление помечается прочитанным (`acknowledged`) и проигрывает
  звук, как это делал обычный баннер.

## Другая версия GNOME

В `metadata.json` указано `"shell-version": ["46"]`, на другой версии GNOME
расширение просто не включится. Чтобы попробовать:

1. Добавь версию в `metadata.json`, например `["46", "47"]`.
2. Проверь, что в новой версии у `MessageTray` всё ещё есть `_showNotification`
   и `_notificationQueue`:
   ```bash
   gresource extract /usr/lib/gnome-shell/libshell-*.so /org/gnome/shell/ui/messageTray.js | grep -n -E '_showNotification|_notificationQueue'
   ```
3. Проверь работу во вложенной сессии (следующий раздел), а уже потом выходи из системы.

## Проверка без выхода из системы

GNOME можно запустить в отдельном окне со своей шиной D-Bus. Чтобы тест не
трогал настоящие настройки, ему нужна копия dconf:

```bash
mkdir -p /tmp/island-test/dconf && cp ~/.config/dconf/user /tmp/island-test/dconf/user
XDG_CONFIG_HOME=/tmp/island-test dbus-run-session -- bash -c '
  gnome-shell --nested --wayland &
  sleep 15
  notify-send -a Telegram "Тест" "Привет из тестового окна"
  sleep 10
  kill %1'
```

В тестовом окне dash-to-panel может оказаться снизу, потому что монитор там
другой. Тогда пилюля рисуется у верхнего края экрана. Ошибки расширения видны
в выводе как `JS ERROR`.

## Выключить или удалить

```bash
gnome-extensions disable notification-island@nurik.local      # выключить
rm -rf ~/.local/share/gnome-shell/extensions/notification-island@nurik.local   # удалить
```

Выключить можно и в Extension Manager → «Установленные». Без расширения
уведомления снова идут обычными баннерами GNOME.

## Необязательно: маленькие критические баннеры

Сейчас обычным баннером показываются только критические уведомления. На этом
ноутбуке они маленькие и стоят по центру под панелью: так их настраивает
расширение Notification Banner. Без него они будут стандартными. Если хочешь так же:

1. Установи Notification Banner (появится окно подтверждения):
   ```bash
   gdbus call --session --dest org.gnome.Shell.Extensions --object-path /org/gnome/Shell/Extensions \
     --method org.gnome.Shell.Extensions.InstallRemoteExtension 'notification-banner@VitalyOstanin'
   ```
2. Положи файл со стилем в папку расширения:
   ```bash
   cp notification-banner/stylesheet.css ~/.local/share/gnome-shell/extensions/notification-banner@VitalyOstanin/
   ```
3. Задай положение:
   ```bash
   d=~/.local/share/gnome-shell/extensions/notification-banner@VitalyOstanin/schemas
   s=org.gnome.shell.extensions.notification-banner
   gsettings --schemadir $d set $s horizontal-position 'center'
   gsettings --schemadir $d set $s vertical-position 'top'
   gsettings --schemadir $d set $s padding-vertical 4
   ```
4. Выйди из системы и зайди снова.

Ширину и шрифт задаёт именно `stylesheet.css` (240 px и 65%), а не ползунки в
настройках Notification Banner: эти ползунки перебивает Blur My Shell. При
обновлении Notification Banner этот файл пропадёт, и его нужно будет
скопировать заново (шаг 2).

## Файлы

```
notification-island/
├── README.md                          этот файл
├── install.sh                         установка Notification Island
├── notification-island@nurik.local/   само расширение
│   ├── metadata.json
│   ├── extension.js
│   └── stylesheet.css                 внешний вид пилюли
└── notification-banner/
    └── stylesheet.css                 размер критических баннеров (необязательно)
```

Расширение установлено в `~/.local/share/gnome-shell/extensions/notification-island@nurik.local/`.
Эта папка — резервная копия и инструкция. Если правишь расширение, правь здесь и
запускай `./install.sh`, чтобы копии не расходились.
