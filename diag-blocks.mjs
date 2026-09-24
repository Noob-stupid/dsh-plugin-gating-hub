// 诊断：把测试的 extractBlocks 原样复刻，打印它实际切出的块，定位"找不到升级脚本块"的真因
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))
const SRC = readFileSync(join(ROOT, 'lib', 'index.js'), 'utf8')
const SRC_RFU = readFileSync(join(ROOT, 'lib', 'server', 'routes', 'framework-upgrade.js'), 'utf8')
const SRC_FR = readFileSync(join(ROOT, 'lib', 'server', 'routes', 'framework.js'), 'utf8')
const SRC_FWIS = readFileSync(join(ROOT, 'lib', 'server', 'domain', 'framework-install-script.js'), 'utf8')

const endMarker = ".filter((l) => l !== '').join('\\r\\n')"
const startMarker = 'const lines = ['
const out = []
for (const [name, source] of [['RFU', SRC_RFU], ['FR', SRC_FR], ['IDX', SRC]]) {
	let at = source.indexOf(endMarker)
	while (at !== -1) {
		const from = source.lastIndexOf(startMarker, at)
		if (from !== -1) out.push({ name, block: source.slice(from + startMarker.length - 1, at) + endMarker })
		at = source.indexOf(endMarker, at + endMarker.length)
	}
}
{
	const at = SRC_FWIS.indexOf(".join('\\r\\n')")
	const from = SRC_FWIS.indexOf('return [')
	if (at !== -1 && from !== -1) {
		out.push({ name: 'FWIS', block: `${SRC_FWIS.slice(from + 'return '.length, at)}.join('\\r\\n')` })
	} else {
		console.log(`FWIS 抽取失败：at=${at} from=${from}`)
	}
}

console.log(`共 ${out.length} 块`)
for (const [i, { name, block }] of out.entries()) {
	const hasInstall = block.includes('function Install-Framework')
	const hasQuar = block.includes('Invoke-Quarantine')
	const hasRollback = block.includes('一键回滚脚本启动')
	console.log(`#${i} [${name}] 长度=${block.length} Install-Framework=${hasInstall} Invoke-Quarantine=${hasQuar} 一键回滚=${hasRollback}`)
	console.log(`    首行: ${JSON.stringify(block.split('\n')[0].slice(0, 90))}`)
	console.log(`    末行: ${JSON.stringify(block.split('\n').slice(-1)[0].slice(0, 90))}`)
}
