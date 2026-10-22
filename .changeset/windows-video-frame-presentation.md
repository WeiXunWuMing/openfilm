---
"openfilm": patch
---

Render: on Windows, use Direct3D 11 when it reports the same GPU as Vulkan, avoiding repeated frame-presentation waits without switching hybrid laptops to their integrated GPU. Keep Vulkan for different or unidentified devices, and Chromium's default when hardware Vulkan is unavailable.
