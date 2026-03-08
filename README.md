<div align="center">
  <img src="icons/icon-128.png" alt="PageForge Logo" width="128" />
  <h1>PageForge</h1>
  <p><strong>A powerful, WYSIWYG browser native web page editor.</strong></p>
  <p>
    <a href="#-features">Features</a> •
    <a href="#-installation-developer-mode">Installation</a> •
    <a href="#️-shortcuts--hotkeys">Shortcuts</a> •
    <a href="#️-architecture-overview">Architecture</a>
  </p>
</div>

<br />

PageForge is a feature-rich, What-You-See-Is-What-You-Get (WYSIWYG) editing tool built directly into your browser. It empowers you to modify text, styling, and layout on any webpage in real-time, with seamless export options to seamlessly integrate your visual tweaks back into your source code.

---

## ✨ Features

### 🛠️ Core Editing

- **Real-Time Text Editing**: Simply double-click any text block to edit it on the fly, directly on the page.
- **Smart Selection & Highlighting**: Hover over elements to see calculated boundaries, click to select, and instantly reveal the properties panel in the sidebar.
- **Robust Undo/Redo System**: Safely experiment with modifications backed by a 50-step history state manager.

### 🎨 Styling & Layout

- **Comprehensive CSS Controls**: Manage fonts, colors, backgrounds, borders, opacity, border-radius, and more from an intuitive visual interface.
- **Spacing Management**: Precisely tweak inner paddings and outer margins.
- **Advanced Layout Modes**: Switch effortlessly between `Block`, `Flex`, and `Grid` layouts with detailed child properties (alignment, wrapping, spacing).
- **Drag & Drop Reordering**: Freely move elements. Use the *Wrap Drop* feature (drag to an element's edge) to automatically wrap elements into a side-by-side Flex container.
- **Multi-Selection & Grouping**: Use `Shift/Cmd/Ctrl + Click` to select multiple elements and group them into layout containers in one click.

### 🚀 Advanced UX Features

- **Time-Travel (History Slider)**: An innovative slider that lets you smoothly transition through the timeline of all your changes, offering a visual "Before & After" morph from the original page to your latest edits.
- **Responsive Viewport Previews**: Test your responsive designs instantly by switching between Desktop, Tablet (`768px`), and Mobile (`390px`) emulator views.
- **Customizable Themes**: The inspector sidebar supports multiple visual aesthetics including Dark, Light, Glassmorphism, and Cyberpunk.

### 📥 Export & Delivery

- **Full HTML Export**: Grab the complete, mutated DOM structure with all your inline style changes fully applied.
- **CSS Patch Generation**: Export only the modified styles as isolated, CSS rules targeting unique IDs—perfect for patching existing codebases cleanly.
- **Action Log History**: Export a comprehensive JSON log of your editing sessions for auditing, debugging, or programmatic replaying.

---

## 📦 Installation (Developer Mode)

PageForge is built on Chrome Manifest V3. Currently, it can be loaded locally using Developer Mode.

1. **Clone the repository**:

   ```bash
   git clone https://github.com/your-username/web-edit.git
   cd web-edit
   ```

2. **Open Chrome Extensions**:
   Navigate to `chrome://extensions/` in your Google Chrome or Chromium-based browser.

3. **Enable Developer Mode**:
   Toggle the **Developer mode** switch in the top right corner.

4. **Load Unpacked**:
   Click the **Load unpacked** button and select the root directory of this project (`web-edit`).

---

## ⌨️ Shortcuts & Hotkeys

Boost your productivity with these built-in hotkeys:

| Shortcut | Action |
| :--- | :--- |
| **`Ctrl / Cmd + Z`** | Undo last action |
| **`Ctrl / Cmd + Shift + Z`** (or `Ctrl+Y`) | Redo action |
| **`Ctrl / Cmd + C`** | Copy selected element(s) |
| **`Ctrl / Cmd + V`** | Paste element(s) contextually into the DOM |
| **`Delete` / `Backspace`** | Delete selected element(s) |
| **`Escape`** | Deselect / Exit edit mode / Cancel drag-and-drop |
| **`Shift` / `Cmd` / `Ctrl` + Click** | Multi-select elements |

---

## 🏗️ Architecture Overview

Built on the modern **Manifest V3** standard, the extension utilizes the following core structures:

- **`manifest.json`**: Core configuration utilizing the `sidePanel` and `debugger` API permissions.
- **`background.js`**: Service Worker acting as the central event bus. Handles state persistence, message passing, and viewport emulation (via the `chrome.debugger` API).
- **`content/`**: Injected scripts running in the active tab. Responsible for native DOM manipulation, hover tracking, element selection, layout calculations, and the WYSIWYG rendering engine.
- **`sidepanel/`**: The frontend UI for the extension controller. Handles state management for the property inspector, theme switching, element insertion, and export logic visualization.

---

## 🤝 Contributing

Contributions, issues, and feature requests are highly appreciated! Feel free to check the [issues page](https://github.com/your-username/web-edit/issues).

1. Fork the Project
2. Create your Feature Branch (`git checkout -b feature/AmazingFeature`)
3. Commit your Changes (`git commit -m 'feat: add some AmazingFeature'`)
4. Push to the Branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
