---
"openfilm": patch
---

Render: on Windows, prefer Direct3D 11 to avoid repeated frame-presentation waits when exporting HEVC footage. Keep Vulkan and Chromium's default renderer as fallbacks when a hardware renderer cannot start.
