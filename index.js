const fs = require('fs')
const WebSocket = require('ws')
const bitcoin = require('bitcoinjs-lib')
const bitcoinMessage = require('bitcoinjs-message')
const ztak = require('ztakio-core')
const EventEmitter = require('events')
const SERVER_URL = process.argv.pop()
const CB_TIMEOUT = 5000
const WIF = fs.readFileSync('../.wif', 'utf8').trim()
const NETWORK = secureLoadJson('.network', ztak.networks.mainnet)

function secureLoadJson(file, def) {
  try {
    let data = fs.readFileSync(file, 'utf8')
    return JSON.parse(data)
  } catch (e) {
    return def
  }
}

function start() {
  const ws = new WebSocket(SERVER_URL)
  const events = new EventEmitter()
  let id = 0
  const cbs = {}
  const send = (method, params, cb) => {
    let ret
    if (!cb) {
      ret = new Promise((resolve, reject) => {
        cb = (err, data) => {
          if (err) {
            reject(err)
          } else {
            resolve(data)
          }
        }
      })
    }

    cbs[id] = {cb, ts: Date.now()}
    ws.send(JSON.stringify({
      id: id++, jsonrpc: '2.0',
      method, params
    }))

    return ret
  }

  ws.on('message', function incoming(data) {
    let ob
    try {
      ob = JSON.parse(data)
    } catch (e) {
      console.log(e)
    }

    if (ob) {
      if (ob.id in cbs) {
        cbs[ob.id].cb(null, ob.result)
        delete cbs[ob.id]
      } else if (ob.method === 'event') {
        // It's a subscription
        events.emit('event', ob.params)
        //console.log('Subscription>', ob)
      }
    }
  })

  let cbCheckInterval = setInterval(() => {
    // Check stale entries on callbacks
    let entries = Object.entries(cbs)
    for (let i=0; i < entries.length; i++) {
      let [key, value] = entries[i]
      if (Date.now() - value.ts > CB_TIMEOUT) {
        delete cbs[key]
        value.cb(new Error('timeout'))
      }
    }
  }, Math.floor(CB_TIMEOUT / 4)).unref()

  let mining = false
  const mine = async (mempool) => {
    if (mining) return
    mining = true
    try {
      console.log('Mining a block')
      const ecpair = bitcoin.ECPair.fromWIF(WIF)
      let network = NETWORK

      const { address } = bitcoin.payments.p2pkh({ pubkey: ecpair.publicKey, network: network })

      if (!mempool) {
        mempool = await send('core.mempool', [])
      }
      let poaSignedTxs = {}

      console.log(`Got ${mempool.length} transactions from the mempool, our address is ${address}`)
      let p = 0
      for (let i=0; i < mempool.length; i++) {
        if (p > 100) {
          break
        }
        p++
        let txid = mempool[i]
        let txFeds = await send('core.get', [`/_/tx.${txid}.feds`])

        for (let fed in txFeds) {
          let fedData = await send('core.get', [`${fed}.meta`])
          if (fedData.FedType === 'poa' && typeof(txFeds[fed]) === 'object') {
            // This federation uses proof of authority
            for (let poaIdx=0; poaIdx < 10000; poaIdx++) {
              let key = `${fed}/_poa_${poaIdx}`
              let poaData = await send('core.get', [key])

              if (poaData !== null) {
                if (poaData === address) {
                  if (!(fed in poaSignedTxs)) {
                    poaSignedTxs[fed] = {}
                  }
                  // We can sign this!
                  //let signature = ecpair.sign(Buffer.from(txid, 'hex'))
                  let signature = bitcoinMessage.sign(txid, ecpair.privateKey, ecpair.compressed)
                  poaSignedTxs[fed][txid] = [poaIdx, signature.toString('base64')]
                  console.log(`${i + 1}/${mempool.length} Included ${txid} from federation ${fed} on the new block`)
                }
              } else {
                // On the first "null" we bailout
                break
              }
            }
          }
        }
      }

      if (Object.keys(poaSignedTxs).length > 0) {
        let opcodes = []
        for (let fed in poaSignedTxs) {
          opcodes.push(`REQUIRE ${fed}`)
          let txs = Object.entries(poaSignedTxs[fed]).sort((a, b) => a[0].localeCompare(b[0]))
          for (let txIdx=0; txIdx < txs.length; txIdx++) {
            let tx = txs[txIdx]
            opcodes.push(`PUSHS "${tx[0]}"`)
            opcodes.push(`PUSHI ${tx[1][0]}`)
            opcodes.push(`PUSHS "${tx[1][1]}"`)
            opcodes.push(`ECALL ${fed}:federation`)
          }
        }
        opcodes.push('PUSHI 1')
        opcodes.push('VERIFY "tx-error-while-verify"')
        opcodes.push(`END`)
        let code = opcodes.join('\n')
        let byteCode = ztak.asm.compile(code)
        let hex = ztak.buildEnvelope(ecpair, byteCode).toString('hex')
        //console.log(hex)
        console.log(`Submitting new block with ${Object.keys(poaSignedTxs).length} transactions, ${hex.length} bytes`)

        for (let i=0; i < 5; i++) {
          try {
            await send('core.block', [hex])
            console.log('Block submitted')
            break
          } catch(e) {
            console.log(`(${i+1}/5 tries) Error while submitting block:`, e)
          }
        }
      }
    } finally {
      mining = false
    }
  }

  let statsInterval
  ws.on('open', () => {
    console.log('Connected to', SERVER_URL)

    send('core.subscribe', ['\\/_\\/mempool'], (err, data) => {
      if (err) {
        throw new Error('Couldnt subscribe to mempool updates')
      } else {
        console.log('Subscribed to mempool updates')
      }
    })

    let mineTimeout
    let waitPeriod = 1500
    const doBlock = async () => {
      await mine()
      mineTimeout = null
      waitPeriod = 1500
    }
    let n = 0
    const tryMine = async (keys) => {
      if (keys && keys.filter(x => x === '/_/mempool').length > 0) {
        if (!mineTimeout) {
          mineTimeout = setTimeout(doBlock, 1500)
        } else if (waitPeriod > 100){
          waitPeriod = Math.ceil(waitPeriod * 0.95)
          clearTimeout(mineTimeout)
          mineTimeout = setTimeout(doBlock, waitPeriod)
        }
      }
    }

    events.on('event', tryMine)

    const checkMempool = async () => {
      let mempool = await send('core.get', ['/_/mempool'])
      if (mempool && mempool.length > 0) {
        //await mine(mempool)
      }
    }
    checkMempool()

    statsInterval = setInterval(async () => {
      let info = await send('core.info', [])
      console.log(info.dbStats)
    }, 30000)
  })

  return () => {
    clearInterval(statsInterval)
    clearInterval(cbCheckInterval)
  }
}

var checkReset = start()

process.on('unhandledRejection', error => {
  console.log('unhandledRejection', error.message);
  checkReset()
  checkReset = start()
});
