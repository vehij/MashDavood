<div align="center">

<img src="build/icon.png" width="120" alt="MashDavood">

# مش داوود · MashDavood

**A clean, minimal Markdown reader & editor with first-class Persian / RTL support.**
یک اپلیکیشن ساده و تمیز برای **خواندن و ویرایش Markdown** با پشتیبانی درجه‌یک از **فارسی و راست‌به‌چپ** و فونت **استعداد**.

[![Download](https://img.shields.io/badge/Download-latest%20release-4a63d8?style=for-the-badge)](https://github.com/vehij/MashDavood/releases/latest)
[![License](https://img.shields.io/badge/license-MIT-777?style=for-the-badge)](LICENSE)

</div>

---

## دانلود · Download

| سیستم | فایل |
|---|---|
| **macOS** — Apple Silicon (M1…M4) | [MashDavood-arm64.dmg](https://github.com/vehij/MashDavood/releases/latest/download/MashDavood-arm64.dmg) |
| **macOS** — Intel | [MashDavood-x64.dmg](https://github.com/vehij/MashDavood/releases/latest/download/MashDavood-x64.dmg) |
| **Windows** — نصب‌کننده ۶۴ بیتی | [MashDavood-x64-Setup.exe](https://github.com/vehij/MashDavood/releases/latest/download/MashDavood-x64-Setup.exe) |
| **Windows** — بدون نصب (Portable) | [MashDavood-x64-Portable.exe](https://github.com/vehij/MashDavood/releases/latest/download/MashDavood-x64-Portable.exe) |
| **Windows** — اگر مرورگر جلوی exe را گرفت | [MashDavood-x64-win.zip](https://github.com/vehij/MashDavood/releases/latest/download/MashDavood-x64-win.zip) |
| **Windows** — ARM | [MashDavood-arm64-Setup.exe](https://github.com/vehij/MashDavood/releases/latest/download/MashDavood-arm64-Setup.exe) |

این لینک‌ها **همیشه آخرین نسخه** را می‌دهند (نام فایل‌ها شماره‌ی نسخه ندارد)، پس می‌شود
همین‌ها را برای هم‌تیمی‌ها فرستاد. فهرست کامل و تغییرات هر نسخه:
**[Releases](https://github.com/vehij/MashDavood/releases/latest)**.

اپ گواهی امضای اپل/مایکروسافت ندارد (هزینه‌ی سالانه دارد)، پس سیستم‌عامل بار اول هشدار می‌دهد:

- **macOS**: اپ امضای محلی (ad-hoc) دارد ولی گواهی اپل ندارد. بار اول بعد از کپی به
  `Applications` پیام «Apple could not verify…» می‌آید: روی *Done* بزنید، بعد
  **System Settings ← Privacy & Security** را باز کنید، پایین صفحه روی **Open Anyway** بزنید
  و تأیید کنید. (نسخه‌های ۱.۱.۰ و قبل‌تر امضا نداشتند و پیام «is damaged» می‌دادند؛ برای آن‌ها:)
  ```bash
  xattr -dr com.apple.quarantine /Applications/MashDavood.app
  ```
  آپدیت‌های بعدی از داخل خود برنامه نصب می‌شوند و این مرحله را ندارند.
- **Windows**: در پیام SmartScreen روی *More info* → *Run anyway*. اگر مرورگر فایل را
  «خطرناک» خواند یا برنامه بعد از نصب باز نشد، راهنمای کامل:
  **[docs/WINDOWS.md](docs/WINDOWS.md)**

صحت فایل‌ها با `SHA256SUMS-*.txt` در همان Release قابل بررسی است.

---

## چه کاری می‌کند

**نمایش و ویرایش**
- **ویرایش در همان حالت نمایش** (Live Preview): سند رندرشده دیده می‌شود و همان‌جا ویرایش می‌شود؛
  علامت‌های مارک‌داون (`#`، `**`، `[]()`…) فقط در خطی که مکان‌نما رویش است ظاهر می‌شوند. جدول،
  نمودار، فرمول، تصویر و front-matter رندرشده‌اند و با کلیک (نمودار: دابل‌کلیک یا دکمه‌ی `</>`) کدشان
  باز می‌شود؛ زیر کد نمودار، خودِ نمودار هم‌زمان به‌روز می‌شود. فایل همیشه همان Markdown دقیق است
- **ویرایش جدول در خود جدول**: کلیک روی هر خانه و نوشتن، بدون دیدن `|`؛ Tab / Enter برای رفتن به خانه‌ی
  بعد (و ساختن ردیف تازه در انتها) و راست‌کلیک برای افزودن/حذف ردیف و ستون و تراز ستون
- دو دکمه بالای پنجره: **Read** (فقط خواندن) و **Edit** (ویرایش) — ⌘E بینشان جابه‌جا می‌کند. در خواندن، دابل‌کلیک روی متن به ویرایش همان‌جا می‌رود
- حالت‌های کلاسیک هم در منوی View هستند: سورس + پیش‌نمایش با اسکرول همگام (⌘3) و فقط سورس (⌘4)
- تب‌های چندگانه، بازیابی نشست قبلی، سایدبار فایل‌ها و پنل فهرست مطالب (Outline)
- ذخیره خودکار (قابل خاموش کردن) + نشانگر تغییرات ذخیره‌نشده + تشخیص تغییر فایل روی دیسک
- Drag & Drop، فایل‌های اخیر، باز شدن مستقیم با دابل‌کلیک روی `.md`

**جدول‌ها، کپی و تنظیمات سریع**
- **تغییر عرض ستون‌های جدول** با کشیدن لبه‌ی سرستون در پیش‌نمایش؛ برای هر فایل ذخیره می‌شود و در
  خروجی PDF/HTML هم همان می‌ماند (دابل‌کلیک = خودکار)
- کلمات فارسی در جدول هیچ‌وقت وسط شکسته نمی‌شوند؛ جهت جدول از اکثریت متن آن تعیین می‌شود
- **دکمه‌ی Copy** بالای پیش‌نمایش: کل سند همان‌طور که دیده می‌شود (HTML برای Word/Docs + متن ساده؛
  جدول‌ها مستقیم در اکسل paste می‌شوند). Shift+کلیک یا ⌥⇧⌘M = خود Markdown
- **پنل Aa** (⌥⌘,): جهت، اندازه‌ی فونت، فاصله‌ی خطوط، عرض متن و تراز دوطرفه — روی خروجی هم اعمال می‌شود
- Front-matter به‌صورت کارت کلید/مقدار

**نمودارهای Mermaid**
- زوم (⌘ + اسکرول / pinch، یا − / +) و جابه‌جایی با کشیدن؛ تغییر ارتفاع قاب از لبه‌ی پایین
- **چیدمان دستی**: در حالت Arrange گره‌ها را بکشید، خطوط و برچسب‌ها همراه می‌آیند
- نمای تمام‌صفحه، ذخیره‌ی PNG / SVG و کپی به‌صورت تصویر
- همه در PDF/HTML همان‌طور چاپ می‌شوند
- **چیدمان همراه فایل** (پیش‌فرض): عرض ستون‌ها و زوم/چیدمان نمودار به‌صورت یک خط توضیح نامرئی
  داخل خود فایل ذخیره می‌شوند (`%% mashdavood …` / `<!-- mashdavood widths: … -->`)؛ گیت‌هاب و بقیه‌ی
  نمایشگرها نشانش نمی‌دهند و با فایل به هر کامپیوتر و هر کسی می‌رسد. اگر نمی‌خواهید فایل تغییر کند،
  در تنظیمات خاموشش کنید تا فقط روی همین کامپیوتر ذخیره شود

**به‌روزرسانی**
- نسخه‌ی جدید که منتشر شود، برنامه خبر می‌دهد (دکمه‌ی آبی بالای پنجره). ویندوز نصبی و مک: دانلود،
  بررسی SHA-256، نصب و اجرای دوباره با یک کلیک؛ Portable/zip: فایل جدید در Downloads
- خاموش‌کردن در تنظیمات · بررسی دستی از منوی *Check for Updates…*

**فارسی و RTL**
- جهت **هر پاراگراف، تیتر و آیتم لیست** به‌صورت خودکار از روی متن تشخیص داده می‌شود؛ سند دوزبانه درست نمایش داده می‌شود
- کد درون‌خطی و فرمول وسط جمله‌ی فارسی ایزوله می‌شوند و ترتیب کلمات اطراف به هم نمی‌ریزد
- در ویرایشگر جهت **هر خط** جداگانه تشخیص داده می‌شود و علائم مارک‌داون (`-`, `1.`, `#`, `[x]`) نادیده گرفته می‌شوند تا لیست فارسی درست راست‌چین شود
- انتخاب متن (سلکشن) در متن ترکیبی فارسی/انگلیسی دقیقاً روی همان کاراکترها می‌نشیند
- شماره‌گذاری لیست‌های فارسی با ارقام فارسی (۱، ۲، ۳)
- قفل کردن جهت روی RTL یا LTR (⇧⌘R / ⇧⌘D / ⇧⌘A برای خودکار)
- فونت **استعداد** (نسخه‌ی Google Fonts، داخل خود برنامه — نصب لازم نیست) برای رابط و پیش‌نمایش؛ در ویرایشگر هم برای متن فارسی استعداد و برای کد مونواسپیس

**محتوای مارک‌داون**
- تیتر، لیست، چک‌لیست، جدول، نقل‌قول، پانویس، `mark`، زیرنویس/بالانویس، دیفینیشن‌لیست
- بلوک‌های هشدار گیت‌هابی: `> [!NOTE]` · `> [!WARNING]` · `> [!TIP]` · `> [!DANGER]`
- **نمودار Mermaid** با تم روشن/تیره · **فرمول ریاضی** با KaTeX · رنگ‌آمیزی کد + دکمه کپی
- Front-matter (YAML)، تصاویر با مسیر نسبی، لینک بین فایل‌های md
- **خروجی PDF و HTML** با همان فونت، جهت و نمودارها

---

## میان‌برها

روی ویندوز ⌘ را Ctrl و ⌥ را Alt بخوانید (خود اپ هم آن‌ها را ترجمه می‌کند).

| کار | کلید |
|---|---|
| باز کردن فایل / پوشه | ⌘O / ⇧⌘O |
| فایل جدید | ⌘N |
| ذخیره / ذخیره به‌نام | ⌘S / ⇧⌘S |
| بستن تب · تب بعدی/قبلی | ⌘W · ⌃Tab / ⌃⇧Tab |
| ویرایش · خواندن · جابه‌جایی بینشان | ⌘1 · ⌘2 · ⌘E |
| سورس + پیش‌نمایش · فقط سورس | ⌘3 · ⌘4 |
| سایدبار · تم روشن/تیره | ⌘\ · ⇧⌘L |
| جهت: خودکار / RTL / LTR | ⇧⌘A / ⇧⌘R / ⇧⌘D |
| جستجو در سند | ⌘F |
| بولد / ایتالیک / لینک | ⌘B / ⌘I / ⌘K |
| کد درون‌خطی / بلوک کد | ⇧⌘C / ⌥⌘C |
| تیتر ۱ تا ۳ | ⌥⌘1 تا ⌥⌘3 |
| لیست نقطه‌ای / شماره‌دار / چک‌لیست | ⇧⌘8 / ⇧⌘7 / ⇧⌘9 |
| نقل‌قول · جدول · نمودار Mermaid | ⇧⌘. · ⌥⌘T · ⌥⌘M |
| خروجی PDF / HTML | ⌘P / ⇧⌘E |
| کپی کل سند (همان‌طور که دیده می‌شود) / به‌صورت Markdown | ⌥⇧⌘C / ⌥⇧⌘M |
| پنل تنظیمات سریع خواندن | ⌥⌘, |
| بزرگ‌نمایی / کوچک‌نمایی / اندازه اصلی | ⌘+ / ⌘− / ⌘0 |
| تنظیمات | ⌘, |

تنظیمات (⌘,): تم، جهت پیش‌فرض، فونت و اندازه ویرایشگر، ارتفاع خط، عرض ستون، ذخیره خودکار، غلط‌یاب، تراز دوطرفه، بررسی خودکار به‌روزرسانی.

---

## Build from source

```bash
npm install
npm run dev          # Vite dev server
npm run electron:dev # اجرای اپ در حالت توسعه (در ترمینال دوم)

npm run dist         # ساخت نصب‌کننده برای سیستم فعلی → release/
npm run dist:win     # فقط ویندوز   (روی مک نیاز به Wine دارد)
npm run dist:mac     # فقط مک‌او‌اس
```

روی مک، برای نصب کامل + ثبت به‌عنوان اپ پیش‌فرض `.md` + نصب فونت:

```bash
./scripts/install.sh
```

انتشار نسخه جدید: یک تگ بزنید، GitHub Actions هر دو نسخه را می‌سازد و در Releases می‌گذارد.

```bash
git tag v1.0.1 && git push --tags
```

---

## Project layout

```
electron/    main process — window, native menu, dialogs, fs, watchers, PDF/HTML export
             updater.js (GitHub release check, download + SHA-256, install)
src/
  styles/    app.css (shell) · markdown.css (preview) · editor.css (CodeMirror)
  renderer/  app.js (state, tabs, sidebar, scroll sync, exports)
             markdown.js (markdown-it + KaTeX + Mermaid + direction + outline)
             editor.js (CodeMirror 6, per-line direction, formatting commands)
             updates.js (update pill + dialog)
assets/      Estedad variable font (OFL)
build/       app icons
docs/        ARCHITECTURE.md · PROGRESS.md · نمونه سند فارسی
scripts/     install.sh · cdp.mjs (headless UI testing) · set-default-md-app.swift
```

جزئیات فنی: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — وضعیت و کارهای بعدی: [docs/PROGRESS.md](docs/PROGRESS.md)

---

## Credits

- فونت [استعداد](https://github.com/aminabedi68/Estedad) ([Google Fonts](https://fonts.google.com/specimen/Estedad)) — SIL OFL 1.1
- [CodeMirror 6](https://codemirror.net) · [markdown-it](https://github.com/markdown-it/markdown-it) · [Mermaid](https://mermaid.js.org) · [KaTeX](https://katex.org) · [Electron](https://electronjs.org)

MIT © Vahid Yaghoubian
