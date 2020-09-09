ztakio-miner:
============

This app watches a ztakio-server instance and "mines" blocks whenever transactions
that are relevant to the federations allowed by this miner's public key are
available.

To configure, first put your keypair WIF into a file called `.wif` in the running
directory.

To mine for a different network than mainnet you can put the network descriptor
into a file called `.network` (the descriptor follows the format of bitcoinjs-lib
network specification JSON).

To run the miner just do `node index.js wss://path_to_your_ztakio_server_websocket`.

License:
=======

ISC Licensed by John Villar 2020.
