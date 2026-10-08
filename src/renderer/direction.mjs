// جهت پایه از نسبت واژه‌ها به دست می‌آید. طول یک نام انگلیسی نباید تعیین‌کننده باشد.
const RTL_LETTER = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/u
const WORDS = /\p{L}[\p{L}\p{M}\u200C\u200D]*/gu
const URL_OR_EMAIL = /(?:https?:\/\/|www\.|mailto:)[^\s<>]+|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/giu

export const PERSIAN_DIGITS = /[\u0660-\u0669\u06F0-\u06F9]/u

export function estimateDirection (text, fallback = 'ltr') {
  const source = String(text || '')
  let rtl = 0
  let total = 0
  for (const word of source.replace(URL_OR_EMAIL, ' ').replace(/\u0640/g, '').match(WORDS) || []) {
    if (RTL_LETTER.test(word[0])) rtl++
    total++
  }
  // آستانهٔ ۴۰٪ از روش برآورد Closure الهام گرفته است.
  // https://github.com/google/closure-library/blob/master/closure/goog/i18n/bidi.js
  // نشانی یا ایمیلِ تنها باید چپ‌به‌راست بماند.
  return total ? (rtl / total > 0.4 ? 'rtl' : 'ltr') : (source.search(URL_OR_EMAIL) >= 0 ? 'ltr' : fallback)
}

// این حذف فقط برای برآورد جهت است. متن اصلی تغییر نمی‌کند.
export function markdownDirectionText (text) {
  return String(text || '')
    .replace(/^\s*(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\s*\1[^\n]*$/gm, ' ')
    .replace(/(`+)[^`]*?\1/g, ' ')
    .replace(/\$\$[\s\S]*?\$\$|\$(?!\s)[^$\n]*?[^\s$]\$/g, ' ')
    .replace(/<!--[^]*?-->|<[^>]*>/g, ' ')
    .replace(/!?\[([^\]]*)\]\([^\n]*?\)|!?\[([^\]]*)\]\[[^\]]*\]/g, '$1$2')
    .replace(/^[\t >]*(?:[-*+]\s+|[0-9۰-۹٠-٩]+[.)]\s+)?(?:\[[ xX]\]\s*)?(?:#{1,6}\s+)?/gm, '')
    .replace(/\[!\w+\]/g, ' ')
}

export function detectDirection (text) {
  return estimateDirection(markdownDirectionText(String(text || '').slice(0, 6000)))
}
