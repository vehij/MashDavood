import { createRenderer, renderMarkdown } from '../src/renderer/markdown.js'
import { MarkdownEditor } from '../src/renderer/editor.js'
import { ensureSyntaxTree } from '@codemirror/language'
import '../src/styles/app.css'
import '../src/styles/markdown.css'
import '../src/styles/editor.css'

function check (condition, message) {
  if (!condition) throw new Error(message)
}

const source = `# برنامهٔ فعال نمونه‌گیری

A و B اولویت پوشش دارد. در نمونه، مشتری دارای عامل A–S و فرم با معیار اصلی یکسان بررسی می‌شود. مشتری با کار انسانی یا ابزار ساده دیده می‌شود. در حداقل مستقل شمرده نمی‌شود. ADLAS مستقل‌اند.

سلام is the Persian word for hello.

## A–S

این متن فارسی با AI و CI نوشته می‌شود.

- [x] ADLAS در حداقل مستقل شمرده نمی‌شود.

\`long English code snippet here\` $x+y+z$ فارسی

[راهنما](https://example.com/long/english/path) در این متن فارسی است.

https://example.com/long/english/path

| Name | شرح |
| --- | --- |
| A و B در این متن فارسی هستند. | **۱۲۳** |

**۱.۲.۰**

\`\`\`text
نمونهٔ کد فارسی
\`\`\`
`

export async function run () {
  const fixture = document.querySelector('#fixture')
  fixture.className = 'app'
  fixture.dataset.dir = 'ltr'
  fixture.style.cssText = 'height:auto;padding:24px;display:grid;grid-template-columns:1fr 1fr;gap:32px'
  const preview = document.createElement('article')
  preview.className = 'markdown-body'
  preview.dir = 'rtl'
  preview.innerHTML = renderMarkdown(createRenderer(), source)
  fixture.append(preview)

  const mixed = [...preview.querySelectorAll('p')].find(p => p.textContent.startsWith('A و B'))
  check(mixed.dir === 'rtl', 'جهت پاراگراف فارسی با شروع انگلیسی درست نیست.')
  check(getComputedStyle(mixed).direction === 'rtl', 'جهت محاسبه‌شده در نمایش اعمال نشد.')
  check(getComputedStyle(mixed).unicodeBidi === 'isolate', 'سبک نمایش جهت را از اولین حرف بازنویسی می‌کند.')
  check(getComputedStyle(mixed).textAlign === 'start', 'هم‌ترازی پاراگراف از جهت آن پیروی نمی‌کند.')
  check([...preview.querySelectorAll('p')].find(p => p.textContent.startsWith('سلام is')).dir === 'ltr', 'جهت متن انگلیسی با شروع فارسی درست نیست.')
  check(preview.querySelector('h2').dir === 'ltr', 'جهت عنوان انگلیسی تغییر کرده است.')
  check(preview.querySelector('li').dir === 'rtl', 'جهت مورد فهرست درست نیست.')
  check([...preview.querySelectorAll('p')].find(p => p.textContent.startsWith('long English')).dir === 'rtl', 'کد و فرمول بر جهت متن اثر گذاشتند.')
  check([...preview.querySelectorAll('p')].find(p => p.textContent.startsWith('راهنما')).dir === 'rtl', 'مقصد پیوند بر جهت متن اثر گذاشت.')
  check([...preview.querySelectorAll('p')].find(p => p.textContent.startsWith('https://')).dir === 'ltr', 'جهت نشانی وبِ تنها باید چپ‌به‌راست باشد.')
  check(preview.querySelector('table').dir === 'rtl', 'جهت جدول فارسی درست نیست.')
  check(preview.querySelector('th').dir === 'ltr', 'جهت خانهٔ انگلیسی درست نیست.')
  check(preview.querySelector('td').dir === 'rtl', 'جهت خانهٔ ترکیبی درست نیست.')
  check(preview.querySelector('[data-weak]').dir === 'rtl', 'جهت رقم‌های فارسی تغییر کرده است.')
  check(getComputedStyle(preview.querySelector('pre')).direction === 'ltr', 'جهت کد باید چپ‌به‌راست باشد.')
  const explicit = document.createElement('div')
  explicit.innerHTML = renderMarkdown(createRenderer(), '<p dir="rtl">English text</p>')
  check(explicit.querySelector('p').dir === 'rtl', 'جهت صریح HTML بازنویسی شد.')

  const host = document.createElement('div')
  host.style.minWidth = '0'
  fixture.append(host)
  const editor = new MarkdownEditor(host, {})
  const editorSource = 'A و B\nدر این پاراگراف متن فارسی ادامه دارد.\n\nسلام is the Persian word for hello.\n\n## A–S\n\n- [x] ADLAS در حداقل مستقل شمرده نمی‌شود.\n\n```text\nنمونهٔ کد فارسی\n```'
  editor.view.dispatch({ changes: { from: 0, to: editor.view.state.doc.length, insert: editorSource } })
  ensureSyntaxTree(editor.view.state, editor.view.state.doc.length, 1000)
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  const lines = [...host.querySelectorAll('.cm-line')]
  for (const text of ['A و B', 'در این پاراگراف', '- [x] ADLAS']) {
    const line = lines.find(l => l.textContent.startsWith(text))
    check(line && line.classList.contains('cm-line-rtl'), `جهت خط ویرایشگر درست نیست: ${text}`)
    check(getComputedStyle(line).unicodeBidi === 'isolate', 'جهت خط در سند چپ‌به‌راست بازنویسی شد.')
  }
  check(lines.find(l => l.textContent.startsWith('سلام is')).classList.contains('cm-line-ltr'), 'جهت خط انگلیسی درست نیست.')
  check(lines.find(l => l.textContent.startsWith('## A')).classList.contains('cm-line-ltr'), 'جهت عنوان انگلیسی در ویرایشگر درست نیست.')
  check(lines.find(l => l.textContent.startsWith('نمونهٔ کد')).classList.contains('cm-line-ltr'), 'جهت کد فارسی در ویرایشگر درست نیست.')

  const liveHost = document.createElement('div')
  fixture.append(liveHost)
  const liveEditor = new MarkdownEditor(liveHost, {})
  const liveSource = '# عنوان\n\n> [!NOTE]\n> ADLAS در حداقل مستقل شمرده نمی‌شود.\n\n| Name | شرح |\n| --- | --- |\n| A و B در این متن فارسی هستند. | فارسی |'
  liveEditor.view.dispatch({ changes: { from: 0, insert: liveSource } })
  liveEditor.setLive(true, {
    renderTable: text => renderMarkdown(createRenderer(), text),
    decorateTable: () => {}
  })
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  check(liveHost.querySelector('.lp-dir-rtl'), 'جهت عنوان یادداشت از متن آن گرفته نشد.')
  const tableHost = liveHost.querySelector('.lp-table')
  check(tableHost, 'جدول نمای زنده ساخته نشد.')
  tableHost._tableEdit.edit(1, 0)
  const field = tableHost.querySelector('.lp-cell-field')
  check(field?.dir === 'rtl', 'جهت خانه هنگام شروع ویرایش درست نیست.')
  check(getComputedStyle(field).unicodeBidi === 'isolate', 'سبک خانهٔ در حال ویرایش جهت را حفظ نمی‌کند.')
  field.textContent = 'سلام is the Persian word for hello.'
  field.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }))
  check(field.dir === 'ltr', 'جهت خانه پس از تغییر متن به‌روز نشد.')
  check(liveEditor.view.state.doc.toString().includes(field.textContent), 'ویرایش خانه در متن سند ثبت نشد.')
  liveEditor.view.destroy()
  liveHost.remove()
  await document.fonts.ready
  return { preview: 'قبول', editor: 'قبول', live: 'قبول', tableEditing: 'قبول', mixedParagraph: mixed.dir, englishHeading: preview.querySelector('h2').dir }
}
