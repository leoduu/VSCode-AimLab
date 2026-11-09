# VSCode-AimLab

*"Just reviewing a selector."* Sure you are.

Aimlab turns the file open in your editor into an aim range — a convincing alibi for an afternoon of "deep work", and the warm-up your evening queue deserves. Same editor, steadier aim.

## Training modes

| Mode | Goal |
| --- | --- |
| **Count** | Clear a fixed number of targets |
| **Timed** | Score as many targets as possible before the timer ends |
| **Tracking** | Keep the pointer inside a moving target |

## Settings

All settings are available from the Aimlab sidebar. Only the entries relevant to the current mode are shown.

| Setting | Values | Meaning |
| --- | --- | --- |
| `aimlab.mode` | `count`, `timed`, `tracking` | Training mode |
| `aimlab.difficulty` | `easy`, `medium`, `hard`, `extreme`, `custom` | Target height, width, timeout and tracking speed |
| `aimlab.range` | `narrow` (40%), `medium` (60%), `wide` (80%), `full` (100%) | Centered area where targets may appear |
| `aimlab.trackingMotion` | `smooth`, `sharp` | Tracking movement style |
| `aimlab.testCount` | 1–1000 | Number of targets in Count mode (default 20) |
| `aimlab.durationSeconds` | 5–3600 | Duration in Timed / Tracking mode (default 30) |
| `aimlab.intervalMs` | 0–10000 | Delay between targets in Timed mode (default 100) |
| `aimlab.custom` | object | Custom height, width, timeout and speed for `custom` difficulty |



## License

[MIT](https://github.com/leoduu/VSCode-AimLab/blob/main/LICENSE.md)
