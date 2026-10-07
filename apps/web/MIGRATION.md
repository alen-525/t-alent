# Front-end migration notes

The UI is an independent React/Vite application. It does not import DeepSeek Harness packages, package runtime paths, DSH boot code, Cordis, an agent loop, model or shell implementations, or session backend services. The reference tree is used only as source material.

## Reused source files

| Source | Migrated file | Treatment |
| --- | --- | --- |
| `packages/client/ui-layout/src/client/columns.ts` | `apps/web/src/columns.ts` | Copied column solver constants and geometry function. |
| `packages/client/ui-layout/src/client/AppFrame.tsx` | `apps/web/src/AppFrame.tsx` | Adapted to plain React child render callback/props; keeps ResizeObserver sizing, responsive collapse, three-column layout, pointer-capture resizing and RAF drag updates. DSH slot/store/action bindings removed. |
| `packages/client/ui-layout/src/client/AppFrame.module.css` | `apps/web/src/AppFrame.module.css` | Retained browser column/resize styles and added a narrow viewport right-panel drawer. Unused native window chrome and overlay styles were removed. App-owned overrides live in `app.css`. |
| `packages/client/ui-theme/src/styles/base.css` | `apps/web/src/base.css` | Copied foundational typography, motion, radius variables. |
| `packages/client/ui-theme/src/styles/design-platform.css` | `apps/web/src/design-platform.css` | Copied platform token sheet. t-alent surfaces use their own CSS variables in `app.css`. |
| `packages/client/ui-theme/src/styles/focus.css`, `scrollbar.css` | matching files in `apps/web/src/` | Copied theme utility sheets. |
| `packages/client/ui-theme/src/styles/montserrat-regular.woff2`, `Montserrat-OFL.txt` | matching files in `apps/web/src/` | Copied font and its OFL notice. |
| `packages/client/ui-primitives/src/Button.tsx` + `.module.css`, `SegmentedControl.tsx` + `.module.css` | corresponding files under `apps/web/src/primitives/` | Adapted the controls/styles used by the UI and small `cx`/focus helpers, with no runtime package dependency. Unused Input and Switch components were removed. |
| `packages/client/ui-theme/src/client/AppearanceRow.tsx` and `.module.css` | `apps/web/src/AppearanceRow.tsx`, `AppearanceRow.module.css` | Adapted to plain theme preference props and lucide icons, with the source's three selectable appearance tiles. |
| `packages/client/ui-theme/src/client/FontSizeRow.tsx` and `.module.css` | `apps/web/src/FontSizeRow.tsx`, `FontSizeRow.module.css` | Adapted to plain value/change/label props; keeps the source stepper interaction. |
| `packages/client/ui-settings-general/src/client/SettingsRoot.tsx` + `SettingsRoot.module.css`; `packages/client/ui-primitives/src/useModalLayer.ts` | `apps/web/src/SettingsPanel.tsx`, `SettingsPanel.module.css` | Adapted to an injected section list and local React state with portal, focus, Escape and close behavior; no settings service/store dependency. The source panel footprint is 800×800, constrained by the viewport, with a 188px navigation rail. |
| `packages/client/ui-sidebar/src/client/SidebarRoot.tsx` and `.module.css` | `apps/web/src/SidebarRoot.tsx`, `SidebarRoot.module.css` | Adapted collapse/expand transition, frozen content width, narrow rail, pointer-based scrollbar linger, and section layout to plain React props and t-alent navigation. DeepSeek logo/primitives and desktop integrations removed. |
| `packages/client/ui-conversation/src/client/skeleton/InputBar.module.css` | `apps/web/src/Composer.module.css` | Adapted the composer card, text area and toolbar geometry for a native textarea; model/session/attachment runtime controls were removed. |

The shell, package management page, preferences, task composer and event display are t-alent components adapted to this narrow framework boundary. Package metadata is validated and stored locally; a host adapter reports which packages are runtime-ready. The user must select one explicitly before task execution is enabled.

DeepSeek Harness source code is MIT licensed. Attribution and license text are retained in [LICENSE.DeepSeek](../../LICENSE.DeepSeek); the repository itself is not included or linked as an application dependency.
