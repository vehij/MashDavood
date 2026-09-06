#!/usr/bin/env node
/**
 * Render .github/RELEASE_NOTES.md for one tag, so the download table on the
 * release page links straight at that release's files.
 *
 *   node scripts/release-notes.mjs v1.0.2 > notes.md
 *   node scripts/release-notes.mjs v1.0.2 --check   # verify every link exists
 *
 * {{V}}   -> version without the leading v
 * {{TAG}} -> the tag
 * {{URL}} -> https://github.com/<repo>/releases/download/<tag>
 *
 * --check asks the GitHub API for the release's assets and fails if the notes
 * link to a name that is not there — a dead download button is worse than none,
 * and asset names have drifted before (the Windows zip is -win.zip, not -x64.zip).
 */
import { readFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'

const [tag, ...flags] = process.argv.slice(2)
if (!tag) {
  console.error('usage: release-notes.mjs <tag> [--check]')
  process.exit(2)
}

const repo = process.env.GITHUB_REPOSITORY || 'vehij/MashDavood'
const version = tag.replace(/^v/, '')
const url = `https://github.com/${repo}/releases/download/${tag}`

const notes = (await readFile(new URL('../.github/RELEASE_NOTES.md', import.meta.url), 'utf8'))
  .replaceAll('{{URL}}', url)
  .replaceAll('{{TAG}}', tag)
  .replaceAll('{{V}}', version)

if (flags.includes('--check')) {
  const listed = JSON.parse(
    execFileSync('gh', ['release', 'view', tag, '--repo', repo, '--json', 'assets'], {
      encoding: 'utf8'
    })
  ).assets.map((a) => a.name)

  const linked = [...notes.matchAll(/releases\/download\/[^/]+\/([^\s)]+)/g)].map((m) => m[1])
  const missing = [...new Set(linked)].filter((name) => !listed.includes(name))

  if (missing.length) {
    console.error(`release ${tag} has no such asset(s):\n  ${missing.join('\n  ')}`)
    console.error(`\nassets present:\n  ${listed.join('\n  ')}`)
    process.exit(1)
  }
  console.error(`all ${new Set(linked).size} linked assets exist in ${tag}`)
}

process.stdout.write(notes)
