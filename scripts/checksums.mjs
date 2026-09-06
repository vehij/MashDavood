#!/usr/bin/env node
/**
 * Write SHA-256 sums for the installers in a directory.
 *
 *   node scripts/checksums.mjs release SHA256SUMS-Windows.txt
 *
 * Node rather than shasum/sha256sum: the Git-for-Windows bash on the CI runner has
 * neither, and a failed hash there silently produced an empty file.
 */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readdir, writeFile } from 'node:fs/promises'
import { join, extname } from 'node:path'

const EXTENSIONS = new Set(['.dmg', '.exe', '.zip', '.appimage'])

const sha256 = (file) =>
  new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    createReadStream(file)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')))
  })

const [dir = 'release', out = 'SHA256SUMS.txt'] = process.argv.slice(2)

const names = (await readdir(dir))
  .filter((n) => EXTENSIONS.has(extname(n).toLowerCase()) && !n.startsWith('SHA256SUMS'))
  .sort()

if (!names.length) {
  console.error(`no installers found in ${dir}`)
  process.exit(1)
}

const lines = []
for (const name of names) lines.push(`${await sha256(join(dir, name))}  ${name}`)

await writeFile(join(dir, out), lines.join('\n') + '\n', 'utf8')
console.log(lines.join('\n'))
