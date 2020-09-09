const fs = require('fs')
const WebSocket = require('ws')
const bitcoin = require('bitcoinjs-lib')
const bitcoinMessage = require('bitcoinjs-message')
const ztak = require('ztakio-core')
const EventEmitter = require('events')
const SERVER_URL = 'wss://hazamaapi.indiesquare.net/ztak'
const CB_TIMEOUT = 5000
const WIF = fs.readFileSync('.wif', 'utf8').trim()
const NETWORK = {
  "messagePrefix": "\u0018Hazama Signed Message:\n",
  "bech32": "haz",
  "bip32": {
    "public": "0x0488b21e",
    "private": "0x0488ade4"
  },
  "H_pubKeyHash": 41,
  "pubKeyHash": 100,
  "wif": 149
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
        console.log('Subscription>', ob)
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

  const mine = async (mempool) => {
    console.log('Mining a block')
    const ecpair = bitcoin.ECPair.fromWIF(WIF)
    let network = NETWORK

    const { address } = bitcoin.payments.p2pkh({ pubkey: ecpair.publicKey, network: network })

    if (!mempool) {
      mempool = await send('core.mempool', [])
    }
    let poaSignedTxs = {}

    for (let i=0; i < mempool.length; i++) {
      let txid = mempool[i]
      let txFeds = await send('core.get', [`/_/tx.${txid}.feds`])

      for (let fed in txFeds) {
        let fedData = await send('core.get', [`${fed}.meta`])
        if (fedData.FedType === 'poa') {
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
      console.log(`Submitting new block with ${Object.keys(poaSignedTxs).length} transactions`)
      await send('core.block', [hex])
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

    events.on('event', async (keys) => {
      if (keys.filter(x => x === '/_/mempool').length > 0) {
        await mine()
      }
    })

    const checkMempool = async () => {
      let mempool = await send('core.get', ['/_/mempool'])
      if (mempool && mempool.length > 0) {
        await mine(mempool)
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
