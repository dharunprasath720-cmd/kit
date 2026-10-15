# Pixel Cat

A small pixel-art cat that lives on your desktop (Windows and macOS).

| You do… | The cat… |
| --- | --- |
| move the mouse | runs after your cursor and stops a polite distance away |
| move it far away | gallops after you, bounding between strides |
| type anywhere | scratches its neck with a hind leg (a different leg each time) |
| click it | purrs and floats hearts |
| drag it | gets picked up by the scruff, wiggles and kicks, then hops when dropped |
| nothing for a while | yawns every ~12 s, then gets sleepy and curls up to snooze |
| hover over it | its name appears under it |
| work for a long time | stretches and shows a speech bubble every 30 min (configurable) |
| start a focus timer | wishes you luck; when time's up it jumps and purrs on screen (click to dismiss) |
| lock it | strolls slowly to a corner (or a spot you saved) and stays there |

It never steals focus, and only the cat itself is clickable.

## Share it as an .exe

```bash
npm run dist
```

Produces `dist/kit.exe`: a single 64-bit Windows file, no install, no Node needed.
It isn't code-signed, so Windows SmartScreen may say "unknown publisher" (More info, then Run anyway).
A macOS build has to be made on a Mac (`npx electron-builder --mac`).

## Run from source

Windows: double-click **Start Pixel Cat.bat**, or on any platform:

```bash
npm install
npm start
```

## Settings

Click the tray icon (or right-click the cat, then Settings). Everything applies live and is saved.

- **Look**: three coats (Indie tabby, Persian, Black), the cat's name (shown on hover) and a size slider.
  The name is asked on first launch and can be changed here any time.
- **Lock in place**: on/off, spot (4 corners or a saved position), "Save spot", and walking speed.
  The cat always walks there; it never teleports. Hotkey: **Ctrl+Alt+L** (Cmd+Alt+L on macOS).
- **Behaviour**: follow on/off, follow distance, chase speed, typing (scratch) and click reactions, nap delay.
- **Focus timers**: label + minutes, saved presets, live countdown list.
  The tray menu (right-click) has a quick "Start a timer" list too.
- **Stretch reminders**: interval (0 = off), your own tips, preview.
- **System**: always on top, start at login, hotkey, hide, quit, reset.

## About typing detection

To react when you type in any app, the cat uses a global keyboard hook
([uiohook-napi](https://github.com/SnosMe/uiohook-napi)). It only notices **that** a key was pressed.
Key codes are never stored or sent anywhere, and the app makes no network requests.
Untick "React when I type" to remove the hook. On macOS, grant Accessibility permission and restart.

## Preview the reminder quickly

```bash
# PowerShell
$env:PIXELCAT_STRETCH_SECONDS = 15; npm start
```

## Layout

```
main.js              window, following, lock, hopping speed, drag, tray, hotkey, hook, reminders
preload.js           whitelisted bridge to the cat window
renderer/cat.js      procedural pixel cat, animation and state
renderer/font.js     5x5 bitmap font (speech bubble, hover name)
settings/            the settings window
tools/make-icons.js  regenerates the tray icon
```
