import assert from 'node:assert/strict'
import { access, readFile } from 'node:fs/promises'
import path from 'node:path'
import { ADAPTERS } from '../packages/runtime/adapters/registry.mjs'

/** Canonical distributed recipes come from the trusted registry, not a fixed count. */
export const agentIds = () => Object.keys(ADAPTERS).sort()

export async function validateSourceRecord(root, id, manifest, lock) {
  const record = JSON.parse(await readFile(path.join(root, 'agent-sources', id, `${manifest.version}.json`), 'utf8'))
  const adapterPackage = JSON.parse(await readFile(path.join(root, 'packages/runtime/adapters', id, 'package.json'), 'utf8'))
  assert.equal(record.packageId, id)
  assert.equal(record.packageVersion, manifest.version)
  assert.equal(record.source.agent, manifest.source?.agent)
  assert.equal(record.source.version, manifest.source?.version)
  assert.equal(record.adapter.id, id)
  assert.equal(record.adapter.version, adapterPackage.version)
  assert.equal(record.adapter.frameworkPackage, adapterPackage.name)
  assert.equal(record.adapter.runtimeVersion, ADAPTERS[id]?.sourceVersion)
  assert.equal(record.source.version, record.adapter.runtimeVersion)
  assert.equal(record.source.package, record.adapter.runtimePackage)
  assert(record.source.repository?.startsWith('https://'), `${id} has an official source repository`)
  assert(record.source.license, `${id} records its upstream license`)
  await access(path.join(root, 'packages/runtime/adapters', id, 'THIRD-PARTY-NOTICES.md'))
  const licenseFile = record.source.licenseFile ?? (id === 'deepseek' ? 'LICENSE' : `LICENSE.${id}`)
  assert.equal(path.basename(licenseFile), licenseFile, `${id} license file is local to its adapter`)
  await access(path.join(root, 'packages/runtime/adapters', id, licenseFile))
  if (record.source.lockfile) {
    assert.equal(adapterPackage.dependencies?.[record.adapter.runtimePackage], record.adapter.runtimeVersion, `${id} fixed runtime dependency`)
    const locked = lock.packages?.[`node_modules/${record.adapter.runtimePackage}`]
    assert(locked, `${id} upstream runtime must appear in package-lock.json`)
    assert.equal(locked.version, record.adapter.runtimeVersion)
    assert.equal(locked.resolved, record.source.lockfile.resolved)
    assert.equal(locked.integrity, record.source.lockfile.integrity)
    if (record.source.lockfile.license) assert.equal(locked.license, record.source.lockfile.license)
    const artifact = record.source.lockfile.platformArtifact
    if (artifact) {
      const pinned = lock.packages?.[`node_modules/${artifact.package}`]
      assert(pinned, `${id} records its fixed platform artifact in package-lock.json`)
      assert.equal(pinned.version, artifact.version)
      assert.equal(pinned.resolved, artifact.resolved)
      assert.equal(pinned.integrity, artifact.integrity)
    }
  } else if (['pypi','github'].includes(record.source.distribution?.ecosystem)) {
    const distribution = record.source.distribution
    assert.equal(distribution.name, record.adapter.runtimePackage)
    assert.equal(distribution.version, record.adapter.runtimeVersion)
    const names = new Set()
    for (const item of [distribution, ...(record.source.distributions ?? [])]) {
      assert(['pypi','github'].includes(item.ecosystem))
      assert.match(item.name, /^[A-Za-z0-9][A-Za-z0-9._-]*$/)
      assert.match(item.version, /^\d+\.\d+\.\d+(?:[A-Za-z0-9.+-]*)$/)
      assert(!names.has(item.name), `${id} has no duplicate Python distribution locks`)
      names.add(item.name)
      assert.match(item.sha256, /^[a-f0-9]{64}$/, `${id} pins ${item.name}'s Python distribution digest`)
      const url = new URL(item.url)
      assert.equal(url.protocol, 'https:')
      if (item.ecosystem === 'pypi') assert.equal(url.hostname, 'files.pythonhosted.org')
      else {
        assert.equal(item, distribution, `${id} source archives identify the primary runtime`)
        assert.equal(url.hostname, 'codeload.github.com')
        assert.match(item.commit, /^[a-f0-9]{40}$/)
        assert.equal(item.commit, record.source.referenceCommit)
        const repository = new URL(record.source.repository)
        assert.equal(repository.hostname, 'github.com')
        assert.equal(url.pathname, `${repository.pathname.replace(/\.git$/, '')}/tar.gz/${item.commit}`)
      }
      assert(!url.username && !url.password && !url.search && !url.hash)
    }
  } else {
    const runtimePackages = { goose: 'goose CLI', roo: '@roo-code/cli' }
    assert(Object.hasOwn(runtimePackages, id), `${id} requires a supported, verified distribution record`)
    assert.equal(record.adapter.runtimePackage, runtimePackages[id])
    const archive = record.source.releaseArchive
    assert.match(archive?.sha256 ?? '', /^[a-f0-9]{64}$/)
    assert.equal(archive.platform, 'darwin-arm64')
    assert.match(record.source.referenceCommit, /^[a-f0-9]{40}$/)
    const repository = new URL(record.source.repository)
    assert.equal(repository.hostname, 'github.com')
    const tag = id === 'roo' ? `cli-v${record.source.version}` : `v${record.source.version}`
    assert.equal(record.source.sourceTag, tag)
    const asset = id === 'roo' ? 'roo-cli-darwin-arm64.tar.gz' : 'goose-aarch64-apple-darwin.tar.bz2'
    assert.equal(archive.url, `https://github.com${repository.pathname}/releases/download/${tag}/${asset}`)
  }
  for (const [name, version] of Object.entries(adapterPackage.dependencies ?? {})) {
    assert.match(version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, `${id} native adapter dependencies are exact versions`)
  }
  if (record.source.archiveOmittedDependencies) {
    const dependencies = record.source.archiveOmittedDependencies
    assert(Array.isArray(dependencies))
    assert.deepEqual(dependencies.map(item => item.name).sort(), Object.keys(adapterPackage.dependencies ?? {}).sort())
    for (const item of dependencies) {
      assert.equal(item.pinnedVersion, adapterPackage.dependencies[item.name])
      const search = [
        `packages/runtime/adapters/${id}/node_modules/${item.name}`,
        `packages/runtime/adapters/node_modules/${item.name}`,
        `packages/runtime/node_modules/${item.name}`,
        `packages/node_modules/${item.name}`,
        `node_modules/${item.name}`,
      ]
      const dependency = search.map(key => lock.packages?.[key]).find(Boolean)
      assert(dependency, `${id} archive dependency ${item.name} must be locked`)
      assert.equal(dependency.version, item.pinnedVersion)
      assert.equal(dependency.resolved, item.resolved)
      assert.equal(dependency.integrity, item.integrity)
    }
  }
  return record
}
