// Copyright 2018 The hyperledger-fabric-desktop Authors. All rights reserved.

import { getConfigDBSingleton } from './createDB';

const FabricClientSDK = require('fabric-client');
const path = require('path');
const util = require('util');
const fs = require('fs');
const { exec } = require('child_process');

const db = getConfigDBSingleton();

const logger = require('electron-log');

class FabricClient {
  constructor() {
    const fabricClient = new FabricClientSDK();
    this.fabric_client = fabricClient;
  }

  _gitConfig() {
    const self = this;
    return new Promise((resolve, reject) => {
      db.find({}, (err, resultList) => {
        if (err) {
          logger.info('the operation of find documents failed!');
          reject('error');
        }
        logger.info('success get config!');
        const output = {
          result: resultList,
          obj: self,
        };
        resolve(output);
        logger.info('result:', resultList);
      });
    });
  }

  _config(input) {
    const obj = input.obj;
    return new Promise((resolve) => {
      logger.info('input:', input.result);
      const config = input.result[0];

      if (config.tlsPeerPath === '' || config.tlsOrdererPath === '') {
        logger.info('+++++++++++++++++');
        obj.flag = false;
      } else {
        logger.info('------------------');
        obj.peerCert = fs.readFileSync(config.tlsPeerPath);
        obj.orderersCert = fs.readFileSync(config.tlsOrdererPath);
        obj.flag = true;
      }

      logger.info('config:', config);
      const storePath = path.join(__dirname, '../../', config.path);
      logger.info(`Store path:${storePath}`);
      obj.config = config;
      obj.store_path = storePath;
      obj.channels = {};

      resolve('success');
    });
  }

  /**
   *
   * @returns {Promise<Client.User | never>}
   * @private
   */
  _enrollUser() {
    const usrName = this.config.username;
    // logger.info('start to load member user.');
    return FabricClientSDK.newDefaultKeyValueStore({ path: this.store_path,
    }).then((stateStore) => {
      // assign the store to the fabric client
      this.fabric_client.setStateStore(stateStore);
      const cryptoSuite = FabricClientSDK.newCryptoSuite();

      // use the same location for the state store (where the users' certificate are kept)
      // and the crypto store (where the users' keys are kept)
      const cryptoStore = FabricClientSDK.newCryptoKeyStore({ path: this.store_path });
      cryptoSuite.setCryptoKeyStore(cryptoStore);
      this.fabric_client.setCryptoSuite(cryptoSuite);

      return this.fabric_client.getUserContext(usrName, true);
    });
  }

  /**
   *
   * @returns {channel}
   * @private
   */
  _setupChannelOnce(channelName) {
    // setup each channel once
    let channel = this.channels[channelName];
    if (!channel) {
      logger.info('******************');
      channel = this.fabric_client.newChannel(channelName);

      if (this.flag) {
        logger.info('-----------');
        this.peer = this.fabric_client.newPeer(this.config.peerGrpcUrl,
          { pem: Buffer.from(this.peerCert).toString(), 'ssl-target-name-override': 'peer0.org1.example.com' });
        channel.addPeer(this.peer);
        this.order = this.fabric_client.newOrderer(this.config.ordererUrl,
          { pem: Buffer.from(this.orderersCert).toString(), 'ssl-target-name-override': 'orderer.example.com' });
        channel.addOrderer(this.order);
      } else {
        logger.info('+++++++++++++++++');
        this.peer = this.fabric_client.newPeer(this.config.peerGrpcUrl);
        channel.addPeer(this.peer);
        this.order = this.fabric_client.newOrderer(this.config.ordererUrl);
        channel.addOrderer(this.order);
      }
      this.channels[channelName] = channel;
    } else {
      channel = this.channels[channelName];
    }
    return channel;
  }

  static _argsNullHelper(args) {
    return args || [];
  }

  /**
   *  查询链码
   *  @returns {Promise<String>}
   * @param chaincodeId {string}
   * @param fcn {string}
   * @param args {[]string}
   * @param channelName {string}
   */
  queryCc(chaincodeId, fcn, args, channelName) {
    logger.info(`start query, chaincodeId:${chaincodeId}, functionName:${fcn}, args:${args}`);

    let channel;
    try {
      channel = this._setupChannelOnce(channelName);
    } catch (err) {
      logger.error(`Failed to create channel :: ${err}`);
      return Promise.reject(err);
    }

    return this._enrollUser().then((user) => {
      if (user && user.isEnrolled()) {
        logger.info('Successfully loaded user1 from persistence, user:', user.toString());
      } else {
        logger.error('Failed to get user1.... run registerUser.js');
        return Promise.reject(new Error('Failed to get user1.... run registerUser.js'));
      }

      const request = {
        chaincodeId,
        fcn,
        args: FabricClient._argsNullHelper(args),
      };

      // send the query proposal to the peer

      return channel.queryByChaincode(request);
    }).then((queryResponses) => {
      logger.info('Query has completed, checking results');
      // queryResponses could have more than one results if there were multiple peers targets
      if (queryResponses && queryResponses.length === 1) {
        if (queryResponses[0] instanceof Error) {
          logger.error('error from query = ', queryResponses[0]);
          return Promise.reject(new Error(queryResponses[0]));
        }
        const result = queryResponses[0].toString();
        logger.info('Success, response is ', result);

        return Promise.resolve(result);
      }
      logger.info('No payloads were returned from query');
      return Promise.reject(new Error('No payloads were returned from query'));
    }).catch((err) => {
      logger.error(`Failed to query successfully :: ${err}`);
      return Promise.reject(new Error(`Failed to query successfully :: ${err}`));
    });
  }

  /**
   *  调用链码，写入账本
   *  @returns {Promise<String>}
   * @param chaincodeId {string}
   * @param fcn {string}
   * @param args {[]string}
   * @param channelName {string}
   */
  invokeCc(chaincodeId, fcn, args, channelName) {
    logger.info(`start invoke, chaincodeId:${chaincodeId}, functionName:${fcn}, args:${args}`);
    let channel;
    try {
      channel = this._setupChannelOnce(channelName);
    } catch (err) {
      logger.error(err);
      return Promise.reject(err);
    }
    let txID;
    const fabricClient = this.fabric_client;

    return this._enrollUser().then((user) => {
      if (user && user.isEnrolled()) {
        logger.info('Successfully loaded user1 from persistence');
      } else {
        logger.error('Failed to get user1.... run registerUser.js');
        return Promise.reject(new Error('Failed to get user1.... run registerUser.js'));
      }

      // get a transaction id object based on the current user assigned to fabric client
      txID = fabricClient.newTransactionID();
      logger.info('Assigning transaction_id: ', txID._transaction_id);

      // must send the proposal to endorsing peers
      const request = {
        // targets: let default to the peer assigned to the client
        chaincodeId,
        fcn,
        args: FabricClient._argsNullHelper(args),
        chainId: channelName,
        txId: txID,
      };

      // send the transaction proposal to the peers
      return channel.sendTransactionProposal(request);
    }).then((results) => {
      const proposalResponses = results[0];
      const proposal = results[1];
      let isProposalGood = false;
      if (proposalResponses && proposalResponses[0].response &&
        proposalResponses[0].response.status === 200) {
        isProposalGood = true;
        logger.info('Transaction proposal was good:');
      } else {
        logger.error('Transaction proposal was bad');
        return Promise.reject(new Error('Transaction proposal was bad'));
      }
      if (isProposalGood) {
        logger.info(util.format(
          'Successfully sent Proposal and received ProposalResponse: Status - %s, message - "%s"',
          proposalResponses[0].response.status, proposalResponses[0].response.message));

        // build up the request for the orderer to have the transaction committed
        const request = {
          proposalResponses,
          proposal,
        };

        // set the transaction listener and set a timeout of 30 sec
        // if the transaction did not get committed within the timeout period,
        // report a TIMEOUT status
        const transactionIDString = txID.getTransactionID();
        const promises = [];

        // send transaction first, so that we know where to check status
        const sendPromise = channel.sendTransaction(request);
        promises.push(sendPromise);

        // get an eventhub once the fabric client has a user assigned. The user
        // is required bacause the event registration must be signed
        const eventHub = fabricClient.newEventHub();
        eventHub.setPeerAddr(this.config.peerEventUrl);

        // using resolve the promise so that result status may be processed
        // under the then clause rather than having the catch clause process
        // the status
        const txPromise = new Promise((resolve, reject) => {
          const handle = setTimeout(() => {
            eventHub.disconnect();
            resolve({ event_status: 'TIMEOUT' });
            // could use reject(new Error('Trnasaction did not complete within 30 seconds'));
          }, 3000);
          eventHub.connect();
          eventHub.registerTxEvent(transactionIDString, (tx, code) => {
            // this is the callback for transaction event status
            // first some clean up of event listener
            clearTimeout(handle);
            eventHub.unregisterTxEvent(transactionIDString);
            eventHub.disconnect();

            // now let the application know what happened
            const returnStatus = { event_status: code, tx_id: transactionIDString };
            if (code !== 'VALID') {
              logger.error(`The transaction was invalid, code = ${code}`);
              resolve(returnStatus);
              // could use reject(new Error('Problem with the tranaction, event status ::'+code));
            } else {
              logger.info(`The transaction has been committed on peer ${eventHub._ep._endpoint.addr}`);
              resolve(returnStatus);
            }
          }, (err) => {
            // this is the callback if something goes wrong
            // with the event registration or processing
            reject(new Error(`There was a problem with the eventhub ::${err}`));
          });
        });
        promises.push(txPromise);

        return Promise.all(promises);
      }
      logger.error('Failed to send Proposal or receive valid response. Response null or status is not 200. exiting...');
      return Promise.reject(new Error('Failed to send Proposal or receive valid response. Response null or status is not 200. exiting...'));
    }).then((results) => {
      logger.info('Send transaction promise and event listener promise have completed');
      // check the results in the order the promises were added to the promise all list
      if (results && results[0] && results[0].status === 'SUCCESS') {
        logger.info('Successfully sent transaction to the orderer.');
      } else {
        logger.error(`Failed to order the transaction. Error code: ${results[0].status}`);
      }

      if (results && results[1] && results[1].event_status === 'VALID') {
        logger.info('Successfully committed the change to the ledger by the peer');
      } else {
        logger.info(`Transaction failed to be committed to the ledger due to ::${results[1].event_status}`);
      }
      logger.info('Invoke result:', results);

      return Promise.resolve('调用成功');
    })
      .catch((err) => {
        logger.error(`Failed to invoke successfully :: ${err}`);
        return Promise.reject(new Error(`Failed to invoke successfully :: ${err}`));
      });
  }

  // TODO: go链码与GOPATH/src的处理
  /**
   * 安装链码。
   * 需要相应语言环境，如go语言。
   * @returns {Promise<String>}
   * @param chaincodePath
   * @param chaincodeName
   * @param chaincodeVersion
   */
  installCc(chaincodePath, chaincodeName, chaincodeVersion) {
    logger.info(`${chaincodePath}, ${chaincodeName}, ${chaincodeVersion}`);
    const self = this;
    return this._enrollUser().then((user) => {
      logger.info('Successfully loaded user from persistence, user:', user.toString());

      const request = {
        targets: [self.peer], // peerAddress
        chaincodePath,
        chaincodeId: chaincodeName,
        chaincodeVersion,
      };
      return self.fabric_client.installChaincode(request);
    }).then((results) => {
      const proposalResponses = results[0];
      if (proposalResponses && proposalResponses[0].response &&
        proposalResponses[0].response.status === 200) {
        logger.info('Transaction proposal was good:');
        return Promise.resolve('success');
      }
      logger.error('Transaction proposal was bad');
      return Promise.reject('fail');
    }, (err) => {
      logger.error(`Failed to send install proposal due to error: ${err.stack}` ? err.stack : err);
      // throw new Error(`Failed to send install proposal due to error: ${err.stack}`
      // ? err.stack : err);
      return Promise.reject('fail');
    }).catch((err) => {
      logger.error(`Failed to install :: ${err}`);
      return Promise.reject('fail');
    });
  }


  /**
   * 实例化链码
   * @returns {Promise<String>}
   * @param channelName
   * @param chaincodeName
   * @param chaincodeVersion
   * @param args
   */
  instantiateCc(channelName, chaincodeName, chaincodeVersion, args) {
    let channel;
    try {
      channel = this._setupChannelOnce(channelName);
    } catch (err) {
      logger.error(err);
      return Promise.reject('fail');
    }
    let txID;

    const self = this;
    return this._enrollUser().then((user) => {
      logger.info('Successfully loaded user from persistence, user:', user.toString());

      txID = self.fabric_client.newTransactionID();
      const request = {
        targets: [self.peer], // peerAddress
        chaincodeId: chaincodeName,
        chaincodeVersion,
        args,
        txId: txID,
      };

      // 提案
      return channel.sendInstantiateProposal(request);
    }).then((results) => {
      const proposalResponses = results[0];
      const proposal = results[1];
      const isGood = proposalResponses && proposalResponses[0].response
        && proposalResponses[0].response.status === 200;

      if (!isGood) {
        return Promise.reject('fail');
      }

      logger.info('Transaction proposal was good:');
      // 提案成功后，提交
      const request = {
        proposalResponses,
        proposal,
      };
      return channel.sendTransaction(request);
    }).then((results) => {
      logger.info('Complete instantiating chaincode.', results);
      return Promise.resolve('success');
    })
      .catch((err) => {
        logger.error(`Fail to instantiate chaincode. Error message: ${err.stack}` ? err.stack : err);
        return Promise.reject('fail');
      });
  }

  /**
   * 根据区块号，获取区块
   * @returns {Promise<block>}
   * @param blockNumber
   * @param channelName
   */
  queryBlock(blockNumber, channelName) {
    let channel;
    try {
      channel = this._setupChannelOnce(channelName);
    } catch (err) {
      logger.error(err);
      return Promise.reject('fail');
    }

    return this._enrollUser()
      .then(() => channel.queryBlock(blockNumber))
      .then(block => Promise.resolve(block));
  }

  /**
   * 获取区块链信息，包含区块高度height
   * @returns {Promise<blockInfo>}
   * @param channelName
   */
  queryInfo(channelName) {
    let channel;
    try {
      channel = this._setupChannelOnce(channelName);
    } catch (err) {
      logger.error(err);
      return Promise.reject('fail');
    }

    return this._enrollUser()
      .then(() => channel.queryInfo())
      .then(blockInfo => Promise.resolve(blockInfo));
  }

  /**
   * 生成证书私钥
   * @returns {Promise<String>}
   */
  importCer(keyPath, certPath) {
    // -------------------- admin start ---------
    this._setupChannelOnce('mychannel');
    const self = this;
    logger.info('start to create admin user.');
    return this._enrollUser()
      .then(() => self.fabric_client.createUser({
        username: self.config.username,
        mspid: 'Org1MSP',
        cryptoContent: {
          privateKey: keyPath,
          signedCert: certPath,
        },
      }),
      ).then(() => Promise.resolve('success'));
    // ---------------admin finish ---------------
  }

  /**
   * 查询已经安装的chaincodes
   * @returns {Promise<Array|chaincodes>}
   */
  queryInstalledChaincodes() {
    try {
      this._setupChannelOnce('mychannel');
    } catch (err) {
      logger.error(err);
      return Promise.reject('fail');
    }
    const self = this;
    return this._enrollUser()
      .then((user) => {
        if (user && user.isEnrolled()) {
          logger.info('Successfully loaded user1 from persistence');
        } else {
          logger.error('Failed to get user1.... run registerUser.js');
          return Promise.reject(new Error('Failed to get user1.... run registerUser.js'));
        }
        return self.fabric_client.queryInstalledChaincodes(self.peer);
      })
      .then((response) => {
        if (response) {
          logger.info('Successfully get response from fabric client');
        } else {
          logger.error('Failed to get response.... ');
          return Promise.reject(new Error('Failed to get response.... '));
        }
        logger.info('response from fabric client:', response);

        return Promise.resolve(response.chaincodes);
      })
      .catch((err) => {
        logger.error(`Fail to query installed chaincodes. Error message: ${err.stack}` ? err.stack : err);
        return Promise.reject('fail');
      });
  }

  /**
   * 查询已经部署的chaincodes
   * @returns {Promise<Array|chaincodes>}
   * @param channelName 通道名字
   */
  queryInstantiatedChaincodes(channelName) {
    let channel;
    try {
      channel = this._setupChannelOnce(channelName);
    } catch (err) {
      logger.error(err);
      return Promise.reject('fail');
    }

    return this._enrollUser()
      .then((user) => {
        if (user && user.isEnrolled()) {
          logger.info('Successfully loaded user1 from persistence');
        } else {
          logger.error('Failed to get user1.... run registerUser.js');
          return Promise.reject(new Error('Failed to get user1.... run registerUser.js'));
        }
        return channel.queryInstantiatedChaincodes();
      })
      .then((response) => {
        if (response) {
          logger.info('Successfully get response from channel');
        } else {
          logger.error('Failed to get response.... ');
          return Promise.reject(new Error('Failed to get response.... '));
        }
        logger.info('response from channel:', response);

        return Promise.resolve(response.chaincodes);
      })
      .catch((err) => {
        logger.error(`Fail to query instantiated chaincodes. Error message: ${err.stack}` ? err.stack : err);
        return Promise.reject('fail');
      });
  }


  /**
   * 查询通道
   * @returns {Promise<Array|channels>}
   * @param channelName 通道名字
   */
  queryChannels() {
    try {
      this._setupChannelOnce('mychannel');
    } catch (err) {
      logger.error(err);
      return Promise.reject('fail');
    }
    const self = this;
    return this._enrollUser()
      .then((user) => {
        if (user && user.isEnrolled()) {
          logger.info('Successfully loaded user1 from persistence');
        } else {
          logger.error('Failed to get user1.... run registerUser.js');
          return Promise.reject(new Error('Failed to get user1.... run registerUser.js'));
        }
        return self.fabric_client.queryChannels(self.peer);
      })
      .then((response) => {
        if (response) {
          logger.info('Successfully get response from fabric client');
        } else {
          logger.error('Failed to get response.... ');
          return Promise.reject(new Error('Failed to get response.... '));
        }
        logger.info('response from fabric client:', response);

        return Promise.resolve(response.channels);
      })
      .catch((err) => {
        logger.error(`Fail to query channels. Error message: ${err.stack}` ? err.stack : err);
        return Promise.reject('fail');
      });
  }


  /**
   * 创建channel.tx文件
   * @returns {Promise<Array|chaincodes>}
   * @param channelName 通道名字
   */
  createChannelTX(channelName) {
    return new Promise((resolve, reject) => {
      const txPath = path.join(__dirname, '../../resources/key/tx');
      const cmd = 'cd ' + txPath + ' && ./configtxgen -profile OneOrgChannel -outputCreateChannelTx ' + channelName + '.tx -channelID ' + channelName; exec(cmd, (err, stdout, stderr) => {
        if (err) {
          console.log(err);
          reject('fail');
        }
        console.log(`stdout: ${stdout}`);
        console.log(`stderr: ${stderr}`);
        resolve('success');
      });
    });
  }

  /**
   * 创建通道
   * @returns {Promise<Array|chaincodes>}
   * @param channelName 通道名字
   */
  createChannel(channelName) {
    const self = this;
    return this.createChannelTX(channelName)
      .then((msg) => {
        logger.info(msg);
        try {
          this._setupChannelOnce(channelName);
        } catch (err) {
          logger.error(err);
          return Promise.reject('fail');
        }
        return this._enrollUser();
      })
      .then((user) => {
        if (user && user.isEnrolled()) {
          logger.info('Successfully loaded user1 from persistence');
        } else {
          logger.error('Failed to get user1.... run registerUser.js');
          return Promise.reject(new Error('Failed to get user1.... run registerUser.js'));
        }
        const tempTxId = self.fabric_client.newTransactionID();
        const envelopeBytes = fs.readFileSync(path.join(__dirname, '../../resources/key/tx/' + channelName + '.tx'));
        const tempConfig = self.fabric_client.extractChannelConfig(envelopeBytes);
        const signature = self.fabric_client.signChannelConfig(tempConfig);
        const stringSignature = signature.toBuffer().toString('hex');
        const tempSignatures = [];
        tempSignatures.push(stringSignature);
        const request = {
          config: tempConfig,
          signatures: tempSignatures,
          name: channelName,
          orderer: self.order,
          txId: tempTxId,
        };
        return self.fabric_client.createChannel(request);
      })
      .then((result) => {
        logger.info(' response ::%j', result);

        if (result.status && result.status === 'SUCCESS') {
          return Promise.resolve('success');
        }
        logger.error('Failed to create the channel. ');
        return Promise.reject('fail');
      })
      .catch((err) => {
        logger.error(`Fail to create channels. Error message: ${err.stack}` ? err.stack : err);
        return Promise.reject('fail');
      });
  }

  /**
   * 创建通道
   * @returns {Promise<Array|chaincodes>}
   * @param channelName 通道名字
   */
  joinChannel(channelName) {
    let channel;
    try {
      channel = this._setupChannelOnce(channelName);
    } catch (err) {
      logger.error(err);
      return Promise.reject('fail');
    }
    const self = this;
    return this._enrollUser()
      .then((user) => {
        if (user && user.isEnrolled()) {
          logger.info('Successfully loaded user1 from persistence');
        } else {
          logger.error('Failed to get user1.... run registerUser.js');
          return Promise.reject('fail');
        }

        const tempTxId = self.fabric_client.newTransactionID();
        const request = {
          txId: tempTxId,
        };
        return channel.getGenesisBlock(request);
      })
      .then((block) => {
        logger.info(' block ::%j', block);
        const tempTargets = [];
        tempTargets.push(self.peer);
        const genesisBlock = block;
        const tempTxId = self.fabric_client.newTransactionID();
        const request = {
          targets: tempTargets,
          block: genesisBlock,
          txId: tempTxId,
        };

        // send genesis block to the peer
        return channel.joinChannel(request);
      })
      .then((results) => {
        logger.info(' results ::%j', results);
        // if (results && results.response && results.response.status === 200) {
        return Promise.resolve('success');
        // }
        // logger.error('Failed to create the channel. ');
        // return Promise.reject(new Error('Failed to create the channel. '));
      })
      .catch((err) => {
        logger.error(`Fail to query channels. Error message: ${err.stack}` ? err.stack : err);
        return Promise.reject('fail');
      });
  }
}


let __fabricClient;

// FabricClient单例模式。后续考虑优化为多套身份，多个client
export default function getFabricClientSingleton() {
  if (!__fabricClient) {
    logger.info('strat create fabric client');
    __fabricClient = new FabricClient();
    return __fabricClient._gitConfig()
      .then(__fabricClient._config)
      .then((result) => {
        logger.info('create fabric client', result);
        return Promise.resolve(__fabricClient);
      });
  }
  return Promise.resolve(__fabricClient);
}

export function deleteFabricClientSingleton() {
  __fabricClient = null;
}
