/**
 * Copyright 2016 IBM All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 *  Unless required by applicable law or agreed to in writing, software
 *  distributed under the License is distributed on an "AS IS" BASIS,
 *  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 *  See the License for the specific language governing permissions and
 *  limitations under the License.
 */

/*
 *   usage:
 *      node pte-main.js <Nid> <uiFile> <tStart> <PTEid>
 *        - Nid: Network id
 *        - uiFile: user input file
 *        - tStart: tStart
 *        - PTEid: PTE id
 */
// This is an end-to-end test that focuses on exercising all parts of the fabric APIs
// in a happy-path scenario
'use strict';


const child_process = require('child_process');

var hfc = require('fabric-client');
var fs = require('fs');
var grpc = require('grpc');
var path = require('path');
var util = require('util');

var testUtil = require('./pte-util.js');
var utils = require('fabric-client/lib/utils.js');


hfc.setConfigSetting('crypto-keysize', 256);


var webUser = null;
var tmp;
var i=0;
var procDone=0;

// input: userinput json file
var PTEid = parseInt(process.argv[5]);
var loggerMsg='PTE ' + PTEid + ' main';
var logger = new testUtil.PTELogger({"prefix":loggerMsg, "level":"info"});

var Nid = parseInt(process.argv[2]);
var uiFile = process.argv[3];
var tStart = parseInt(process.argv[4]);
logger.info('input parameters: Nid=%d, uiFile=%s, tStart=%d PTEid=%d', Nid, uiFile, tStart, PTEid);
var uiContent = JSON.parse(fs.readFileSync(uiFile));

var txCfgPtr;
if ( typeof(uiContent.txCfgPtr) === 'undefined' ) {
    txCfgPtr=uiContent;
} else {
    logger.info('[Nid=%d pte-main] txCfgPtr: %s', Nid, uiContent.txCfgPtr);
    txCfgPtr = JSON.parse(fs.readFileSync(uiContent.txCfgPtr));
}

var ccDfnPtr;
if ( typeof(uiContent.ccDfnPtr) === 'undefined' ) {
    ccDfnPtr=uiContent;
} else {
    ccDfnPtr = JSON.parse(fs.readFileSync(uiContent.ccDfnPtr));
    logger.info('[Nid=%d pte-main] ccDfnPtr: %s', Nid, uiContent.ccDfnPtr);
}


var TLS=txCfgPtr.TLS.toUpperCase();

var channelOpt=uiContent.channelOpt;
var channelName=channelOpt.name;
var channelOrgName = [];
for (i=0; i<channelOpt.orgName.length; i++) {
    channelOrgName.push(channelOpt.orgName[i]);
}
logger.info('TLS: %s', TLS);
logger.info('channelName: %s', channelName);
logger.info('channelOrgName.length: %d, channelOrgName: %s', channelOrgName.length, channelOrgName);

var svcFile = uiContent.SCFile[0].ServiceCredentials;
logger.info('svcFile; ', svcFile);
hfc.addConfigFile(path.resolve(__dirname, svcFile));
var ORGS = hfc.getConfigSetting('test-network');
var goPath=process.env.GOPATH;
if ( typeof(ORGS.gopath) === 'undefined' ) {
    goPath = '';
} else if ( ORGS.gopath == 'GOPATH') {
    goPath = process.env['GOPATH'];
} else {
    goPath = ORGS.gopath;
}
logger.info('GOPATH: ', goPath);

var users =  hfc.getConfigSetting('users');


var transType = txCfgPtr.transType.toUpperCase();
var tCurr;

// timeout option
var timeoutOpt;
var cfgTimeout=200000;   // default 200 sec
if ((typeof( txCfgPtr.timeoutOpt ) !== 'undefined')) {
    timeoutOpt = parseInt(uiContent.timeoutOpt);
    logger.info('main - timeoutOpt: %j', timeoutOpt);
    if ((typeof( timeoutOpt.preConfig ) !== 'undefined')) {
        cfgTimeout = parseInt(timeoutOpt.preConfig);
    }
}
logger.info('main - cfgTimeout: ', cfgTimeout);

// default chaincode language: golang
var language='golang';
var testDeployArgs = [];
var chaincodePath;
var metadataPath;
function initDeploy() {
    if ((typeof( ccDfnPtr.deploy.language ) !== 'undefined')) {
        language=ccDfnPtr.deploy.language.toLowerCase();
    }

    for (i=0; i<ccDfnPtr.deploy.args.length; i++) {
        testDeployArgs.push(ccDfnPtr.deploy.args[i]);
    }

    // If language is golang, then user specifies path relative to gopath.  Note: since SDK prepends
    // GOPATH/src to any golang chaincodePath, PTE will use it as defined in the json file.
    // And for other chaincode languages, if user defines goPath, then they will also specify path
    // relative to gopath.  In that case, the PTE will prepend GOPATH/src here.  Otherwise (not golang
    // and no gopath defined) PTE uses the chaincodepath exactly as specified (user should specify an
    // absolute path in the input json file).
    if (language == 'golang') {
        chaincodePath = ccDfnPtr.deploy.chaincodePath;
    } else if (goPath !== '') {
        chaincodePath = path.join(goPath, 'src', ccDfnPtr.deploy.chaincodePath);
    } else {
        chaincodePath = ccDfnPtr.deploy.chaincodePath;
    }
    logger.info('chaincode language: %s, path: %s', language, chaincodePath);

    // If user defines goPath, then they must also specify path relative to gopath in the input json file.
    // In that case, the PTE must prepend GOPATH/src here.  Otherwise PTE uses the metadataPath exactly as
    // specified (user should specify an absolute path) in the input json file.
    if ((typeof( ccDfnPtr.deploy.metadataPath ) !== 'undefined')) {
        if (goPath !== '') {
            metadataPath = path.join(goPath, 'src', ccDfnPtr.deploy.metadataPath);
        } else {
            metadataPath=ccDfnPtr.deploy.metadataPath;
        }
        logger.info('metadataPath: %s', metadataPath);
    }
}

var tx_id = null;
var nonce = null;

var the_user = null;

var cfgtxFile;
var allEventhubs = [];
var org;
var orgName;

var orderer;

var sBlock = 0;
var eBlock = 0;
var qOrg ;
var qPeer ;

var testSummaryArray=[];

function printChainInfo(channel) {
    logger.info('[printChainInfo] channel name: ', channel.getName());
    logger.info('[printChainInfo] orderers: ', channel.getOrderers());
    logger.info('[printChainInfo] peers: ', channel.getPeers());
    logger.info('[printChainInfo] events: ', allEventhubs);
}


function clientNewOrderer(client, org) {
    var ordererID = ORGS[org].ordererID;
    var data;
    logger.info('[clientNewOrderer] org: %s, ordererID: %s', org, ordererID);
    if (TLS == 'ENABLED') {
        data = testUtil.getTLSCert('orderer', ordererID);
        if ( data !== null ) {
            let caroots = Buffer.from(data).toString();

            orderer = client.newOrderer(
                ORGS['orderer'][ordererID].url,
                {
                    'pem': caroots,
                    'ssl-target-name-override': ORGS['orderer'][ordererID]['server-hostname']
                }
            );
        }
    } else {
        orderer = client.newOrderer(ORGS['orderer'][ordererID].url);
    }
    logger.info('[clientNewOrderer] orderer: %s', ORGS['orderer'][ordererID].url);
}

function chainAddOrderer(channel, client, org) {
    logger.info('[chainAddOrderer] channel name: ', channel.getName());
    var ordererID = ORGS[org].ordererID;
    var data;
    if (TLS == 'ENABLED') {
        data = testUtil.getTLSCert('orderer', ordererID);
        if ( data !== null ) {
            let caroots = Buffer.from(data).toString();

            channel.addOrderer(
                client.newOrderer(
                    ORGS['orderer'][ordererID].url,
                    {
                        'pem': caroots,
                        'ssl-target-name-override': ORGS['orderer'][ordererID]['server-hostname']
                    }
                )
            );
        }
    } else {
        channel.addOrderer(
            client.newOrderer(ORGS['orderer'][ordererID].url)
        );
    }
    logger.info('[chainAddOrderer] channel orderers: ', channel.getOrderers());
}

function channelAddPeer(channel, client, org) {
    logger.info('[channelAddPeer] channel name: ', channel.getName());
    var data;
    var peerTmp;
    var targets = [];

    for (let key in ORGS[org]) {
        if (ORGS[org].hasOwnProperty(key)) {
            if (key.includes('peer')) {
                if (TLS == 'ENABLED') {
                    data = testUtil.getTLSCert(org, key);
                    if ( data !== null ) {
                        peerTmp = client.newPeer(
                            ORGS[org][key].requests,
                            {
                                pem: Buffer.from(data).toString(),
                                'ssl-target-name-override': ORGS[org][key]['server-hostname']
                            }
                        );
                        targets.push(peerTmp);
                        channel.addPeer(peerTmp);
                    }
                } else {
                    peerTmp = client.newPeer( ORGS[org][key].requests);
                    targets.push(peerTmp);
                    channel.addPeer(peerTmp);
                }
            }
        }
    }
    logger.info('[channelAddPeer] channel peers: ', channel.getPeers());

    return targets;
}

function channelAddQIPeer(channel, client, qorg, qpeer) {
    logger.info('[channelAddQIPeer] channel name: ', channel.getName());
    logger.info('[channelAddQIPeer] qorg %s qpeer: ', qorg,qpeer);
    var data;
    var peerTmp;
    var targets = [];

    for (let key in ORGS[qorg]) {
        if (ORGS[qorg].hasOwnProperty(key)) {
            if (key.indexOf(qpeer) === 0) {
                if (TLS == 'ENABLED') {
                    data = testUtil.getTLSCert(qorg, key);
                    if ( data !== null ) {
                        peerTmp = client.newPeer(
                            ORGS[qorg][key].requests,
                            {
                                pem: Buffer.from(data).toString(),
                                'ssl-target-name-override': ORGS[qorg][key]['server-hostname']
                            }
                        );
                        targets.push(peerTmp);
                        channel.addPeer(peerTmp);
                    }
                } else {
                    peerTmp = client.newPeer( ORGS[qorg][key].requests);
                    targets.push(peerTmp);
                    channel.addPeer(peerTmp);
                }
            }
        }
    }
    logger.info('[channelAddQIPeer] channel peers: ', channel.getPeers());

    return targets;
}

function channelAddPeer1(channel, client, org) {
    logger.info('[channelAddPeer1] channel name: %s, org: %s', channel.getName(), org);
    var data;
    var peerTmp;
    var targets = [];

    for (let key in ORGS[org]) {
        if (ORGS[org].hasOwnProperty(key)) {
            if (key.includes('peer')) {
                if (TLS == 'ENABLED') {
                    data = testUtil.getTLSCert(org, key);
                    if ( data !== null ) {
                        peerTmp = client.newPeer(
                            ORGS[org][key].requests,
                            {
                                pem: Buffer.from(data).toString(),
                                'ssl-target-name-override': ORGS[org][key]['server-hostname']
                            }
                        );
                        targets.push(peerTmp);
                        channel.addPeer(peerTmp);
                    }
                } else {
                    peerTmp = client.newPeer( ORGS[org][key].requests);
                    targets.push(peerTmp);
                    channel.addPeer(peerTmp);
                }
                break;
            }
        }
    }
    logger.debug('[channelAddPeer1] org: %s, channel peers: ', org, channel.getPeers());

    return targets;
}

function channelAddPeerEventJoin(channel, client, org) {
    logger.info('[channelAddPeerEvent] channel name: ', channel.getName());
            var data;
            var eh;
            var peerTmp;

            var targets = [];
            var eventHubs = [];

            for (let key in ORGS[org]) {
                if (ORGS[org].hasOwnProperty(key)) {
                    if (key.includes('peer')) {
                        if (TLS == 'ENABLED') {
                            data = testUtil.getTLSCert(org, key);
                            if ( data !== null ) {
                                targets.push(
                                    client.newPeer(
                                        ORGS[org][key].requests,
                                        {
                                            pem: Buffer.from(data).toString(),
                                            'ssl-target-name-override': ORGS[org][key]['server-hostname']
                                        }
                                    )
                                );
                            }
                        } else {
                            targets.push(
                                client.newPeer(
                                    ORGS[org][key].requests
                                )
                            );
                            logger.info('[channelAddPeerEvent] peer: ', ORGS[org][key].requests);
                        }

                        eh=client.newEventHub();
                        if (TLS == 'ENABLED') {
                            data = testUtil.getTLSCert(org, key);
                            if ( data !== null ) {
                                eh.setPeerAddr(
                                    ORGS[org][key].events,
                                    {
                                        pem: Buffer.from(data).toString(),
                                        'ssl-target-name-override': ORGS[org][key]['server-hostname']
                                    }
                                );
                            }
                        } else {
                            eh.setPeerAddr(ORGS[org][key].events);
                        }
                        eh.connect();
                        eventHubs.push(eh);
                        logger.info('[channelAddPeerEvent] requests: %s, events: %s ', ORGS[org][key].requests, ORGS[org][key].events);
                    }
                }
            }

    allEventhubs = allEventhubs.concat(eventHubs);
    return { targets: targets, eventHubs: eventHubs };
}

function channelAddEvent(channel, client, org) {
    logger.info('[channelAddEvent] channel name: ', channel.getName());
            var data;
            var eh;
            var peerTmp;
            var eventHubs = [];

            for (let key in ORGS[org]) {
                if (ORGS[org].hasOwnProperty(key)) {
                    if (key.includes('peer')) {

                        eh=client.newEventHub();
                        if (TLS == 'ENABLED') {
                            data = testUtil.getTLSCert(org, key);
                            if ( data !== null ) {
                                eh.setPeerAddr(
                                    ORGS[org][key].events,
                                    {
                                        pem: Buffer.from(data).toString(),
                                        'ssl-target-name-override': ORGS[org][key]['server-hostname']
                                    }
                                );
                            }
                        } else {
                            eh.setPeerAddr(ORGS[org][key].events);
                        }
                        eh.connect();
                        eventHubs.push(eh);
                        logger.info('[channelAddEvent] requests: %s, events: %s ', ORGS[org][key].requests, ORGS[org][key].events);
                        break;
                    }
                }
            }

    allEventhubs = allEventhubs.concat(eventHubs);
    return eventHubs;
}

var chaincode_id;
var chaincode_ver;
function getCCID() {
    var channelID = uiContent.channelID;
    chaincode_id = uiContent.chaincodeID+channelID;
    chaincode_ver = uiContent.chaincodeVer;
    logger.info('[getCCID] Nid: %d, chaincode_id: %s, chaincode_ver: %s', Nid, chaincode_id, chaincode_ver);
}


// output report file
var rptFile='pteReport.txt';
var sTime=new Date();

// latency output
var latency_peer=[0,0,0,0];
var latency_orderer=[0,0,0,0];
var latency_event=[0,0,0,0];
function update_latency_array(lat_new, rawText) {
    var lat_tmp=[0,0,0,0];
    lat_tmp[0]=parseInt(rawText.substring(rawText.indexOf("tx num=")+7, rawText.indexOf(", total")).trim());
    lat_tmp[1]=parseInt(rawText.substring(rawText.indexOf("total time:")+11, rawText.indexOf("ms")).trim());
    lat_tmp[2]=parseInt(rawText.substring(rawText.indexOf("min=")+4, rawText.indexOf("ms, max")).trim());
    lat_tmp[3]=parseInt(rawText.substring(rawText.indexOf("max=")+4, rawText.indexOf("ms, avg")).trim());

    lat_new[0]=lat_new[0]+lat_tmp[0];    // time
    lat_new[1]=lat_new[1]+lat_tmp[1];    // tx number
    if ( lat_new[2] == 0 ) {             // min
        lat_new[2]=lat_tmp[2];
    } else if ( lat_tmp[2] < lat_new[2] ) {
        lat_new[2]=lat_tmp[2];
    }
    if ( lat_new[3] == 0 ) {             // max
        lat_new[3]=lat_tmp[3];
    } else if ( lat_tmp[3] > lat_new[3] ) {
        lat_new[3]=lat_tmp[3];
    }

}

// test begins ....
performance_main();

// install chaincode
function chaincodeInstall(channel, client, org) {
    var orgName = ORGS[org].name;
    logger.info('[chaincodeInstall] org: %s, org Name: %s, channel name: %s', org, orgName, channel.getName());

    var cryptoSuite = hfc.newCryptoSuite();
    cryptoSuite.setCryptoKeyStore(hfc.newCryptoKeyStore({path: testUtil.storePathForOrg(Nid, orgName)}));
    client.setCryptoSuite(cryptoSuite);

    chainAddOrderer(channel, client, org);

    var targets = channelAddPeer(channel, client, org);
    //printChainInfo(channel);

    //sendInstallProposal
    getCCID();
    var request_install = {
        targets: targets,
        chaincodePath: chaincodePath,
        metadataPath: metadataPath,
        chaincodeId: chaincode_id,
        chaincodeType: language,
        chaincodeVersion: chaincode_ver
    };

    logger.info('request_install: %j', request_install);

    client.installChaincode(request_install)
    .then(
        function(results) {
            var proposalResponses = results[0];
            var proposal = results[1];
            var header   = results[2];
            var all_good = true;
            for(var i in proposalResponses) {
                let one_good = false;
                if (proposalResponses && proposalResponses[0].response && proposalResponses[0].response.status === 200) {
                    one_good = true;
                    logger.info('[chaincodeInstall] org(%s): install proposal was good', org);
                } else {
                    logger.error('[chaincodeInstall] org(%s): install proposal was bad', org);
                }
                all_good = all_good & one_good;
            }
            if (all_good) {
                logger.info(util.format('[chaincodeInstall] Successfully sent install Proposal to peers in (%s:%s) and received ProposalResponse: Status - %s', channelName, orgName, proposalResponses[0].response.status));
                evtDisconnect();
            } else {
                logger.error('[chaincodeInstall] Failed to send install Proposal in (%s:%s) or receive valid response. Response null or status is not 200. exiting...', channelName, orgName);
                evtDisconnect();
                process.exit();
            }

        }, (err) => {
            logger.error('[chaincodeInstall] Failed to install chaincode in (%s:%s) due to error: ', channelName, orgName, err);
            evtDisconnect();
            process.exit();

        });
}

function buildChaincodeProposal(client, the_user, type, upgrade, transientMap) {
        let tx_id = client.newTransactionID();

        // send proposal to endorser
        getCCID();
        var request = {
                chaincodePath: chaincodePath,
                chaincodeId: chaincode_id,
                chaincodeVersion: chaincode_ver,
                fcn: ccDfnPtr.deploy.fcn,
                args: testDeployArgs,
                chainId: channelName,
                chaincodeType: type,
                'endorsement-policy': ccDfnPtr.deploy.endorsement,
                txId: tx_id

                // use this to demonstrate the following policy:
                // 'if signed by org1 admin, then that's the only signature required,
                // but if that signature is missing, then the policy can also be fulfilled
                // when members (non-admin) from both orgs signed'
/*
                'endorsement-policy': {
                        identities: [
                                { role: { name: 'member', mspId: ORGS['org1'].mspid }},
                                { role: { name: 'member', mspId: ORGS['org2'].mspid }},
                                { role: { name: 'admin', mspId: ORGS['org1'].mspid }}
                        ],
                        policy: {
                                '1-of': [
                                        { 'signed-by': 2},
                                        { '2-of': [{ 'signed-by': 0}, { 'signed-by': 1 }]}
                                ]
                        }
                }
*/
        };

        if(upgrade) {
                // use this call to test the transient map support during chaincode instantiation
                request.transientMap = transientMap;
        }

        return request;
}

//instantiate chaincode
function chaincodeInstantiate(channel, client, org) {
        var cryptoSuite = hfc.newCryptoSuite();
        cryptoSuite.setCryptoKeyStore(hfc.newCryptoKeyStore({path: testUtil.storePathForOrg(Nid, orgName)}));
        client.setCryptoSuite(cryptoSuite);

        logger.info('[chaincodeInstantiate] org= %s, org name=%s, channel name=%s', org, orgName, channel.getName());

        chainAddOrderer(channel, client, org);
        //channelAddPeerEvent(chain, client, org);
        //channelAddAnchorPeer(channel, client, org);
        var ivar=0
        for (ivar=0; ivar<channelOrgName.length; ivar++ ) {
            var orgInstantiate = channelOrgName[ivar];
            channelAddPeer1(channel, client, orgInstantiate);
        }
        let eventHubs = channelAddEvent(channel, client, org);
        //printChainInfo(channel);

        channel.initialize()
        .then((success) => {
            logger.info('[chaincodeInstantiate:Nid=%d] Successfully initialize channel[%s]', Nid, channel.getName());
            var upgrade = false;

            var badTransientMap = { 'test1': 'transientValue' }; // have a different key than what the chaincode example_cc1.go expects in Init()
            var transientMap = { 'test': 'transientValue' };
            var request = buildChaincodeProposal(client, the_user, language, upgrade, badTransientMap);
            tx_id = request.txId;

            // sendInstantiateProposal
            //logger.info('request_instantiate: ', request_instantiate);
            return channel.sendInstantiateProposal(request, cfgTimeout);
        },
        function(err) {
            logger.error('[chaincodeInstantiate:Nid=%d] Failed to initialize channel[%s] due to error: ', Nid,  channelName, err.stack ? err.stack : err);
            evtDisconnect();
            process.exit();
        })
    .then(
        function(results) {
            var proposalResponses = results[0];
            var proposal = results[1];
            var header   = results[2];
            var all_good = true;
            for(var i in proposalResponses) {
                let one_good = false;
                if (proposalResponses && proposalResponses[i].response && proposalResponses[i].response.status === 200) {
                    one_good = true;
                    logger.info('[chaincodeInstantiate] channelName(%s) chaincode instantiation was good', channelName);
                } else {
                    logger.error('[chaincodeInstantiate] channelName(%s) chaincode instantiation was bad', channelName);
                }
                all_good = all_good & one_good;
            }
            if (all_good) {
                logger.info(util.format('[chaincodeInstantiate] Successfully sent chaincode instantiation Proposal and received ProposalResponse: Status - %s', proposalResponses[0].response.status));


                var request = {
                    proposalResponses: proposalResponses,
                    proposal: proposal,
                    header: header
                };

                var deployId = tx_id.getTransactionID();
                var eventPromises = [];
                eventHubs.forEach((eh) => {
                    let txPromise = new Promise((resolve, reject) => {
                        let handle = setTimeout(reject, cfgTimeout);

                        eh.registerTxEvent(deployId.toString(), (tx, code) => {
                            var tCurr1=new Date().getTime();
                            clearTimeout(handle);
                            eh.unregisterTxEvent(deployId);

                            if (code !== 'VALID') {
                                logger.error('[chaincodeInstantiate] The chaincode instantiate transaction was invalid, code = ' + code);
                                reject();
                            } else {
                                logger.info('[chaincodeInstantiate] The chaincode instantiate transaction was valid.');
                                resolve();
                            }
                        });
                    });

                    eventPromises.push(txPromise);
                });

                var sendPromise = channel.sendTransaction(request);
                var tCurr=new Date().getTime();
                logger.info('[chaincodeInstantiate] Promise.all tCurr=%d', tCurr);
                return Promise.all([sendPromise].concat(eventPromises))

                .then((results) => {

                    logger.info('[chaincodeInstantiate] Event promise all complete and testing complete');
                    return results[0]; // the first returned value is from the 'sendPromise' which is from the 'sendTransaction()' call
                }).catch((err) => {
                    var tCurr1=new Date().getTime();
                    logger.error('[chaincodeInstantiate] failed to send instantiate transaction: tCurr=%d, elapse time=%d', tCurr, tCurr1-tCurr);
                    //logger.error('Failed to send instantiate transaction and get notifications within the timeout period.');
                    evtDisconnect();
                    throw new Error('Failed to send instantiate transaction and get notifications within the timeout period.');

                });
            } else {
                logger.error('[chaincodeInstantiate] Failed to send instantiate Proposal or receive valid response. Response null or status is not 200. exiting...');
                evtDisconnect();
                throw new Error('Failed to send instantiate Proposal or receive valid response. Response null or status is not 200. exiting...');
            }
        },
        function(err) {

                logger.error('Failed to send instantiate proposal due to error: ' + err.stack ? err.stack : err);
                evtDisconnect();
                throw new Error('Failed to send instantiate proposal due to error: ' + err.stack ? err.stack : err);
        })
    .then((response) => {
            if (response.status === 'SUCCESS') {
                logger.info('[chaincodeInstantiate(Nid=%d)] Successfully instantiate transaction on %s. ', Nid, channelName);
                evtDisconnect();
            } else {
                logger.error('[chaincodeInstantiate(Nid=%d)] Failed to instantiate transaction on %s. Error code: ', Nid, channelName, response.status);
                evtDisconnect();
            }

        }, (err) => {
            logger.error('[chaincodeInstantiate(Nid=%d)] Failed to instantiate transaction on %s due to error: ', Nid, channelName, err.stack ? err.stack : err);
            evtDisconnect();
        }
    );
}

function readAllFiles(dir) {
        var files = fs.readdirSync(dir);
        var certs = [];
        files.forEach((file_name) => {
                let file_path = path.resolve(dir,file_name);
                logger.info('[readAllFiles] looking at file ::'+file_path);
                let data = fs.readFileSync(file_path);
                certs.push(data);
        });
        return certs;
}

//create channel
function createOneChannel(client ,channelOrgName) {

    var config;
    var envelope_bytes;
    var signatures = [];
    var key;

    var username ;
    var secret;
    var submitter = null;

    hfc.setConfigSetting('key-value-store', 'fabric-client/lib/impl/FileKeyValueStore.js');

    // If user defines goPath, then they must also specify path relative to gopath in the input json file.
    // In that case, the PTE must prepend GOPATH/src here.  Otherwise PTE uses the channelTX exactly as
    // specified (user should specify an absolute path) in the input json file.
    var channelTX=channelOpt.channelTX;
    if ( goPath !== '' ) {
        channelTX = path.join(goPath, 'src', channelOpt.channelTX);
    }
    logger.info('[createOneChannel] channelTX: ', channelTX);
    envelope_bytes = fs.readFileSync(channelTX);
    config = client.extractChannelConfig(envelope_bytes);
    logger.info('[createOneChannel] Successfull extracted the config update from the configtx envelope: ', channelTX);

    clientNewOrderer(client, channelOrgName[0]);

    hfc.newDefaultKeyValueStore({
        path: testUtil.storePathForOrg(Nid, orgName)
    }).then((store) => {
        client.setStateStore(store);
        var submitePromises= [];
        channelOrgName.forEach((org) => {
            submitter = new Promise(function (resolve,reject) {
                username=ORGS[org].username;
                secret=ORGS[org].secret;
                orgName = ORGS[org].name;
                logger.info('[createOneChannel] org= %s, org name= %s', org, orgName);
                client._userContext = null;
                resolve(testUtil.getSubmitter(username, secret, client, true, Nid, org, svcFile));
            });
            submitePromises.push(submitter);
        });
        // all the orgs
        return Promise.all(submitePromises);
    })
    .then((results) => {
        results.forEach(function(result){
            var signature = client.signChannelConfig(config);
            logger.info('[createOneChannel] Successfully signed config update for one organization ');
            // collect signature from org admin
            signatures.push(signature);
        });
        return signatures;
    }).then((sigs) =>{
        client._userContext = null;
        return testUtil.getOrderAdminSubmitter(client, channelOrgName[0], svcFile);
    }).then((admin) => {
        the_user = admin;
        logger.info('[createOneChannel] Successfully enrolled user \'admin\' for', "orderer");
        var signature = client.signChannelConfig(config);
        logger.info('[createOneChannel] Successfully signed config update: ', "orderer");
        // collect signature from org admin
        signatures.push(signature);

        //logger.info('[createOneChannel] signatures: ', signatures);
        logger.info('[createOneChannel] done signing: %s', channelName);

        // build up the create request
        let tx_id = client.newTransactionID();
	let nonce = tx_id.getNonce();
        var request = {
            config: config,
            signatures : signatures,
            name : channelName,
            orderer : orderer,
            txId  : tx_id,
            nonce : nonce
        };
        //logger.info('request: ',request);
        return client.createChannel(request);
    }, (err) => {
        logger.error('Failed to enroll user \'admin\'. ' + err);
        evtDisconnect();
        process.exit();
    }).then((result) => {
        logger.info('[createOneChannel] Successfully created the channel (%s).', channelName);
        evtDisconnect();
        process.exit();
    }, (err) => {
        logger.error('Failed to create the channel (%s) ', channelName);
        logger.error('Failed to create the channel:: %j '+ err.stack ? err.stack : err);
        evtDisconnect();
        process.exit();
    })
    .then((nothing) => {
        logger.info('Successfully waited to make sure new channel was created.');
        evtDisconnect();
        process.exit();
    }, (err) => {
        logger.error('Failed due to error: ' + err.stack ? err.stack : err);
        evtDisconnect();
        process.exit();
    });
}

// join channel
function joinChannel(channel, client, org) {
        var orgName = ORGS[org].name;
        logger.info('[joinChannel] Calling peers in organization (%s) to join the channel (%s)', orgName, channelName);
        var username = ORGS[org].username;
        var secret = ORGS[org].secret;
        logger.info('[joinChannel] user=%s, secret=%s', username, secret);
        var genesis_block = null;
        var eventHubs = [];
        var blockCallbacks = [];

        // add orderers
        chainAddOrderer(channel, client, org);

        //printChainInfo(channel);

        return hfc.newDefaultKeyValueStore({
                path: testUtil.storePathForOrg(Nid, orgName)
        }).then((store) => {
                client.setStateStore(store);
                client._userContext = null;
                return testUtil.getOrderAdminSubmitter(client, org, svcFile)
        }).then((admin) => {
                logger.info('[joinChannel:%s] Successfully enrolled orderer \'admin\'', org);
                the_user = admin;
                logger.debug('[joinChannel] orderer admin: ', admin);

                tx_id = client.newTransactionID();
                var request = {
                        txId :  tx_id
                };
                return channel.getGenesisBlock(request);
        }).then((block) =>{
                logger.info('[joinChannel:org=%s:%s] Successfully got the genesis block', channelName, org);
                genesis_block = block;

                client._userContext = null;
                return testUtil.getSubmitter(username, secret, client, true, Nid, org, svcFile);
        }).then((admin) => {
                logger.info('[joinChannel] Successfully enrolled org:' + org + ' \'admin\'');
                the_user = admin;
                logger.debug('[joinChannel] org admin: ', admin);

                // add peers and events
                var targeteh = channelAddPeerEventJoin(channel, client, org);
                eventHubs = targeteh.eventHubs;
                var targets = targeteh.targets;

                var eventPromises = [];

                eventHubs.forEach((eh) => {
                        let txPromise = new Promise((resolve, reject) => {
                                let handle = setTimeout(reject, 30000);

                                var cb = eh.registerBlockEvent((block) => {
                                        clearTimeout(handle);

                                        // in real-world situations, a peer may have more than one channels so
                                        // we must check that this block came from the channel we asked the peer to join
                                        if(block.data.data.length === 1) {
                                                // Config block must only contain one transaction
                                                var channel_header = block.data.data[0].payload.header.channel_header;

                                                if (channel_header.channel_id === channelName) {
                                                        logger.info('[joinChannel] The new channel has been successfully joined on peer '+ eh.getPeerAddr());
                                                        resolve();
                                                } else {
                                                        //logger.error('[joinChannel] The new channel has not been succesfully joined');
                                                        //reject();
                                                }
                                        }
                                }, (err) => {
                                    logger.error('[joinChannel] Failed to registerBlockEvent due to error: ' + err.stack ? err.stack : err);
                                    throw new Error('[joinChannel] Failed to registerBlockEvent due to error: ' + err.stack ? err.stack : err);
                                });
                                blockCallbacks.push(cb);
                        }, (err) => {
                            logger.error('[joinChannel] Failed to Promise due to error: ' + err.stack ? err.stack : err);
                            throw new Error('Failed to Promise due to error: ' + err.stack ? err.stack : err);
                        });

                        eventPromises.push(txPromise);
                });

                tx_id = client.newTransactionID();
                let request = {
                        targets : targets,
                        block : genesis_block,
                        txId :  tx_id
                };

                var sendPromise = channel.joinChannel(request);
                return Promise.all([sendPromise].concat(eventPromises));
        }, (err) => {
                logger.error('[joinChannel] Failed to enroll user \'admin\' due to error: ' + err.stack ? err.stack : err);
                evtDisconnect();
                throw new Error('[joinChannel] Failed to enroll user \'admin\' due to error: ' + err.stack ? err.stack : err);
        })
        .then((results) => {
                logger.info(util.format('[joinChannel] join Channel R E S P O N S E : %j', results));

                if(results[0] && results[0][0] && results[0][0].response && results[0][0].response.status == 200) {
                        logger.info('[joinChannel] Successfully joined peers in (%s:%s)', channelName, orgName);
                        evtDisconnect(eventHubs, blockCallbacks);
                } else {
                        logger.error('[joinChannel] Failed to join peers in (%s:%s)', channelName, orgName);
                        evtDisconnect(eventHubs, blockCallbacks);
                        throw new Error('[joinChannel] Failed to join channel');
                }
        }, (err) => {
                logger.error('[joinChannel] Failed to join channel due to error: ' + err.stack ? err.stack : err);
                evtDisconnect(eventHubs, blockCallbacks);
        });
}

function joinOneChannel(channel, client, org) {
        logger.info('[joinOneChannel] org: ', org);

        joinChannel(channel, client, org)
        .then(() => {
                logger.info('[joinOneChannel] Successfully joined peers in organization %s to join the channel %s', ORGS[org].name, channelName);
                process.exit();
        }, (err) => {
                logger.error(util.format('[joinOneChannel] Failed to join peers in organization "%s" to the channel', ORGS[org].name));
                process.exit();
        })
        .catch(function(err) {
                logger.error('[joinOneChannel] Failed to join channel: ' + err);
                process.exit();
        });

}

function queryBlockchainInfo(channel, client, org) {

    logger.info('[queryBlockchainInfo] channel (%s)', channelName);
    var username = ORGS[org].username;
    var secret = ORGS[org].secret;
    //logger.info('[queryBlockchainInfo] user=%s, secret=%s', username, secret);
    sBlock = txCfgPtr.queryBlockOpt.startBlock;
    eBlock = txCfgPtr.queryBlockOpt.endBlock;
    qOrg = txCfgPtr.queryBlockOpt.org;
    qPeer = txCfgPtr.queryBlockOpt.peer;
    logger.info('[queryBlockchainInfo] query block info org:peer:start:end=%s:%s:%d:%d', qOrg, qPeer, sBlock, eBlock);

    hfc.setConfigSetting('key-value-store','fabric-client/lib/impl/FileKeyValueStore.js');
    var cryptoSuite = hfc.newCryptoSuite();
    cryptoSuite.setCryptoKeyStore(hfc.newCryptoKeyStore({path: testUtil.storePathForOrg(Nid, orgName)}));
    client.setCryptoSuite(cryptoSuite);

    chainAddOrderer(channel, client, org);

    channelAddQIPeer(channel, client, qOrg, qPeer);

    return hfc.newDefaultKeyValueStore({
            path: testUtil.storePathForOrg(orgName)
    }).then( function (store) {
            client.setStateStore(store);
            return testUtil.getSubmitter(username, secret, client, true, Nid, org, svcFile);
    }).then((admin) => {
            logger.info('[queryBlockchainInfo] Successfully enrolled user \'admin\'');
            the_user = admin;

            return channel.initialize();
    }).then((success) => {
            logger.info('[queryBlockchainInfo] Successfully initialized channel');
            return channel.queryInfo();
    }).then((blockchainInfo) => {
            var blockHeight = blockchainInfo.height - 1;
            logger.info('[queryBlockchainInfo] Channel queryInfo() returned block height='+blockchainInfo.height);
            if ( eBlock > blockHeight ) {
                 logger.info('[queryBlockchainInfo] eBlock:block height = %d:%d', eBlock, blockHeight);
                 logger.info('[queryBlockchainInfo] reset eBlock to block height');
                 eBlock = blockHeight;
            }
            //var block;

            var qBlks = [];
            for (i = sBlock; i <= eBlock; i++) {
                qBlks.push(parseInt(i));
            }

            var qPromises = [];
            var qi = 0;
            var qb = null;
            qBlks.forEach((qi) => {
                qb = new Promise(function(resolve, reject) {
                    resolve(channel.queryBlock(qi));
                });
                qPromises.push(qb);
            });
            return Promise.all(qPromises);
            //return channel.queryBlock(6590);
    }).then((block) => {
            var totalLength=0;
            block.forEach(function(block){

                totalLength = totalLength + block.data.data.length;
                logger.info('[queryBlockchainInfo] block:Length:accu length= %d:%d:%d', block.header.number, block.data.data.length, totalLength);
            });
            logger.info('[queryBlockchainInfo] blocks= %d:%d, totalLength= %j', sBlock, eBlock, totalLength);
            process.exit();

    }).catch((err) => {
            throw new Error(err.stack ? err.stack : err);
    });

}

function performance_main() {
    var channelCreated = 0;
    // set timeout for create/join channel and install/instantiate chaincode
    hfc.setConfigSetting('request-timeout', cfgTimeout);
    // send proposal to endorser
    for (var i=0; i<channelOrgName.length; i++ ) {
        let org = channelOrgName[i];
        let orgName=ORGS[org].name;
        logger.info('[performance_main] org= %s, org Name= %s', org, orgName);
        let client = new hfc();

        if ( transType == 'INSTALL' ) {
            initDeploy();
            let username = ORGS[org].username;
            let secret = ORGS[org].secret;
            logger.info('[performance_main] Deploy: user= %s, secret= %s', username, secret);

            hfc.newDefaultKeyValueStore({
                path: testUtil.storePathForOrg(Nid, orgName)
            })
            .then((store) => {
                client.setStateStore(store);
                testUtil.getSubmitter(username, secret, client, true, Nid, org, svcFile)
                .then(
                    function(admin) {
                        logger.info('[performance_main:Nid=%d] Successfully enrolled user \'admin\'', Nid);
                        the_user = admin;
                        var channel = client.newChannel(channelName);
                        chaincodeInstall(channel, client, org);
                    },
                    function(err) {
                        logger.error('[Nid=%d] Failed to wait due to error: ', Nid, err.stack ? err.stack : err);
                        evtDisconnect();

                        return;
                    }
                );
            }, (err) => {
                logger.error('[Nid=%d] Failed to install chaincode on org(%s) to error: ', Nid, org, err.stack ? err.stack : err);
                evtDisconnect();
            });
        } else if ( transType == 'INSTANTIATE' ) {
            initDeploy();
            var username = ORGS[org].username;
            var secret = ORGS[org].secret;
            logger.info('[performance_main] instantiate: user= %s, secret= %s', username, secret);

            hfc.newDefaultKeyValueStore({
                path: testUtil.storePathForOrg(Nid, orgName)
            })
            .then((store) => {
                client.setStateStore(store);
                testUtil.getSubmitter(username, secret, client, true, Nid, org, svcFile)
                .then(
                    function(admin) {
                        logger.info('[performance_main:Nid=%d] Successfully enrolled user \'admin\'', Nid);
                        the_user = admin;
                        var channel = client.newChannel(channelName);
                        chaincodeInstantiate(channel, client, org);
                    },
                    function(err) {
                        logger.error('[Nid=%d] Failed to wait due to error: ', Nid, err.stack ? err.stack : err);
                        evtDisconnect();

                        return;
                    }
                );
            });
            // chaincodeInstantiate send requests to all orgs, so no need to iterate
            break;
        } else if ( transType == 'CHANNEL' ) {
            if ( channelOpt.action.toUpperCase() == 'CREATE' ) {
                // create channel once
                if(channelCreated == 0) {
                    createOneChannel(client, channelOrgName);
                    channelCreated = 1;
                }
            } else if ( channelOpt.action.toUpperCase() == 'JOIN' ) {
                var channel = client.newChannel(channelName);
                logger.info('[performance_main] channel name: ', channelName);
                joinChannel(channel, client, org);
            }
        } else if ( transType == 'QUERYBLOCK' ) {
            var channel = client.newChannel(channelName);
            logger.info('[performance_main] channel name: ', channelName);
            queryBlockchainInfo(channel, client, org);
        } else if ( transType == 'INVOKE' ) {
            // spawn off processes for transactions
            getCCID();
            var nProcPerOrg = parseInt(txCfgPtr.nProcPerOrg);
            var invokeType = txCfgPtr.invokeType.toUpperCase();
            logger.info('nProcPerOrg ', nProcPerOrg);
            for (var j = 0; j < nProcPerOrg; j++) {
                var workerProcess = child_process.spawn('node', ['./pte-execRequest.js', j, Nid, uiFile, tStart, org, PTEid]);

                workerProcess.stdout.on('data', function (data) {
                    logger.info('stdout: ' + data);
                    if (data.indexOf('pte-exec:completed') > -1) {
                        var dataStr=data.toString();
                        var tempDataArray =dataStr.split("\n");
                        for (var i=0; i<tempDataArray.length;i++) {
                            if (tempDataArray[i].indexOf('pte-exec:completed') > -1) {
                                testSummaryArray.push(tempDataArray[i]);
                            }
                        }


                    }
                });

                workerProcess.stderr.on('data', function (data) {
                    logger.info('stderr: ' + data);
                });

                workerProcess.on('close', function (code) {
                });

                workerProcess.on('exit', function (code) {
                    procDone = procDone+1;
                    logger.info("Child proc exited, procId=%d ,exit code=%d",procDone, code );

                    if ( procDone === nProcPerOrg*channelOrgName.length ) {

                        var summaryIndex;

                        var maxInvokeDuration=0;
                        var minInvokeDuration=0;
                        var maxQueryDuration=0;
                        var minQueryDuration=0;
                        var maxMixedDuration=0;
                        var minMixedDuration=0;
                        var totalInvokeTimeout=0;

                        var totalInvokeTrans=0;
                        var totalInvokeTps=0;
                        var totalQueryTrans=0;
                        var totalQueryTps=0;
                        var totalInvokeTime=0;
                        var totalQueryTime=0;
                        var totalMixedTPS=0;
                        var totalMixedTime=0;
                        var totalMixedInvoke=0;
                        var totalMixedQuery=0;

                        var stmp=0;
                        var etmp=0;

                        for (summaryIndex in testSummaryArray ) {
                            var rawText=testSummaryArray[summaryIndex].toString();
                            logger.info('Test Summary[%d]: %s',summaryIndex, rawText.substring(rawText.indexOf("[Nid")));
                            if (rawText.indexOf("execTransMode")>-1) {
                                logger.info("ERROR occurred:" +rawText);
                                continue;
                            };
                            if (rawText.indexOf("execModeConstant")>-1) {
                                logger.info("ERROR occurred:" +rawText);
                                continue;
                            };
                            if (rawText.indexOf("eventRegister")>-1) {
                                var transNum= parseInt(rawText.substring(rawText.indexOf("(sent)=")+7,rawText.indexOf("(",rawText.indexOf("(sent)=")+7)).trim());
                                totalInvokeTrans=totalInvokeTrans+transNum;
                                var tempTimeoutNum=parseInt(rawText.substring(rawText.indexOf("timeout:")+8).trim());
                                totalInvokeTimeout=totalInvokeTimeout+tempTimeoutNum;
                                var tempDur=parseInt(rawText.substring(rawText.indexOf(") in")+4,rawText.indexOf("ms")).trim());
                                totalInvokeTime=totalInvokeTime+tempDur;

                                if (tempDur >maxInvokeDuration ) {
                                    maxInvokeDuration= tempDur;
                                }
                                if ((tempDur <minInvokeDuration ) ||(minInvokeDuration ==0) ) {
                                    minInvokeDuration= tempDur;
                                }
                                var tempInvokeTps=parseFloat(rawText.substring(rawText.indexOf("Throughput=")+11,rawText.indexOf("TPS")).trim());
                                if (tempInvokeTps >0 ) {
                                    totalInvokeTps =totalInvokeTps+tempInvokeTps;
                                }

                                var tmp=parseInt(rawText.substring(rawText.indexOf("start")+5, rawText.indexOf("end")).trim());
                                var tmp1=parseInt(rawText.substring(rawText.indexOf("end")+3, rawText.indexOf(", #event")).trim());
                                if ( stmp == 0 ) {
                                    stmp = tmp;
                                } else if ( stmp > tmp ) {
                                    stmp = tmp;
                                }
                                if ( etmp == 0 ) {
                                    etmp = tmp1;
                                } else if ( etmp < tmp1 ) {
                                    etmp = tmp1;
                                }

                                continue;
                            };
                            if (rawText.indexOf("peer latency stats")>-1) {
                                update_latency_array(latency_peer, rawText);
                                logger.info("Test Summary (%s): latency_peer", chaincode_id, latency_peer);
                            }
                            if (rawText.indexOf("orderer latency stats")>-1) {
                                update_latency_array(latency_orderer, rawText);
                            }
                            if (rawText.indexOf("event latency stats")>-1) {
                                update_latency_array(latency_event, rawText);
                            }
                            if (rawText.indexOf("invoke_query_mix")>-1) {
                                var mixedTransNum= parseInt(rawText.substring(rawText.indexOf("pte-exec:completed")+18,rawText.indexOf("Invoke(move)")).trim());
                                totalMixedInvoke=totalMixedInvoke+mixedTransNum;
                                var mixedQueryNum=parseInt(rawText.substring(rawText.indexOf("and")+3, rawText.indexOf("Invoke(query)")).trim());
                                totalMixedQuery=totalMixedQuery+mixedQueryNum;
                                var tempDur=parseInt(rawText.substring(rawText.indexOf(") in")+4,rawText.indexOf("ms")).trim());
                                totalMixedTime=totalMixedTime+tempDur;
                                if (tempDur >maxMixedDuration ) {
                                    maxMixedDuration= tempDur;
                                }
                                if ((tempDur <minMixedDuration ) ||(minMixedDuration ==0) ) {
                                    minMixedDuration= tempDur;
                                }
                                var tempMixedTps=parseFloat(rawText.substring(rawText.indexOf("Throughput=")+11,rawText.indexOf("TPS")).trim());
                                if (tempMixedTps >0 ) {
                                    totalMixedTPS =totalMixedTPS+tempMixedTps;
                                }

                                var tmp=parseInt(rawText.substring(rawText.indexOf("start")+5, rawText.indexOf("end")).trim());
                                var tmp1=parseInt(rawText.substring(rawText.indexOf("end")+3, rawText.indexOf(",Thr")).trim());
                                if ( stmp == 0 ) {
                                    stmp = tmp;
                                } else if ( stmp > tmp ) {
                                    stmp = tmp;
                                }
                                if ( etmp == 0 ) {
                                    etmp = tmp1;
                                } else if ( etmp < tmp1 ) {
                                    etmp = tmp1;
                                }

                                continue;
                            };
                            if ( (invokeType == "QUERY") && (rawText.indexOf("invoke_query_")>-1) ) {
                                var queryTransNum= parseInt(rawText.substring(rawText.indexOf("pte-exec:completed")+18,rawText.indexOf("transaction",rawText.indexOf("pte-exec:completed")+18)).trim());
                                totalQueryTrans=totalQueryTrans+queryTransNum;

                                var tempDur=parseInt(rawText.substring(rawText.indexOf(") in")+4,rawText.indexOf("ms")).trim());
                                totalQueryTime=totalQueryTime+tempDur;
                                if (tempDur >maxQueryDuration ) {
                                    maxQueryDuration= tempDur;
                                }
                                if ((tempDur <minQueryDuration ) ||(minQueryDuration ==0) ) {
                                    minQueryDuration= tempDur;
                                }
                                var tempQueryTps=parseFloat(rawText.substring(rawText.indexOf("Throughput=")+11,rawText.indexOf("TPS")).trim());
                                if (tempQueryTps >0 ) {
                                    totalQueryTps =totalQueryTps+tempQueryTps;
                                }

                                var tmp=parseInt(rawText.substring(rawText.indexOf("start")+5, rawText.indexOf("end")).trim());
                                var tmp1=parseInt(rawText.substring(rawText.indexOf("end")+3, rawText.indexOf(",Thr")).trim());
                                if ( stmp == 0 ) {
                                    stmp = tmp;
                                } else if ( stmp > tmp ) {
                                    stmp = tmp;
                                }
                                if ( etmp == 0 ) {
                                    etmp = tmp1;
                                } else if ( etmp < tmp1 ) {
                                    etmp = tmp1;
                                }

                                continue;
                            };
                        }
                        logger.info("Test Summary: Total %d Threads run completed",procDone);
                        if (totalInvokeTrans>0) {
                            logger.info("Test Summary (%s):Total INVOKE transaction=%d, timeout transaction=%d, the Min duration is %d ms,the Max duration is %d ms,Avg duration=%d ms, total throughput=%d TPS", chaincode_id, totalInvokeTrans, totalInvokeTimeout, minInvokeDuration, maxInvokeDuration,totalInvokeTime/procDone, totalInvokeTps.toFixed(2));

                            var dur=etmp-stmp;
                            var iTPS=1000*totalInvokeTrans/dur;
                            logger.info("Aggregate Test Summary (%s):Total INVOKE transaction %d, timeout transaction %d, start %d end %d duration is %d ms, TPS %d", chaincode_id, totalInvokeTrans, totalInvokeTimeout, stmp, etmp, dur, iTPS.toFixed(2));


                            // transaction output
                            var buff = "======= "+loggerMsg+" Test Summary: executed at " + sTime + " =======\n";
                            fs.appendFileSync(rptFile, buff);
                            buff = "("+channelName+":"+chaincode_id+"): INVOKE transaction stats\n";
                            fs.appendFileSync(rptFile, buff);
                            buff = "("+channelName+":"+chaincode_id+"):\tTotal transactions "+totalInvokeTrans + "  timeout transactions "+totalInvokeTimeout+"\n";
                            fs.appendFileSync(rptFile, buff);

                            buff = "("+channelName+":"+chaincode_id+"):\tstart "+stmp+"  end "+etmp+"  duration "+dur+" ms \n";
                            fs.appendFileSync(rptFile, buff);
                            buff = "("+channelName+":"+chaincode_id+"):\tTPS "+iTPS.toFixed(2)+ "\n";
                            fs.appendFileSync(rptFile, buff);

                            // peer latency output (endorsement)
                            buff = "("+channelName+":"+chaincode_id+"): peer latency stats (endorsement)\n";
                            fs.appendFileSync(rptFile, buff);
                            buff = "("+channelName+":"+chaincode_id+"):\ttotal transactions: "+ latency_peer[0] +"  total time: "+ latency_peer[1] +" ms \n";
                            fs.appendFileSync(rptFile, buff);
                            if ( latency_peer[0] > 0 ) {
                                buff = "("+channelName+":"+chaincode_id+"):\tmin: "+ latency_peer[2] +" ms  max: "+ latency_peer[3] +" ms  avg: "+ latency_peer[1]/latency_peer[0].toFixed(2) +" ms \n";
                                fs.appendFileSync(rptFile, buff);
                            }

                            // orderer latency output (transaction ack)
                            buff = "("+channelName+":"+chaincode_id+"): orderer latency stats (transaction ack)\n";
                            fs.appendFileSync(rptFile, buff);
                            buff = "("+channelName+":"+chaincode_id+"):\ttotal transactions: "+ latency_orderer[0] +"  total time: "+ latency_orderer[1] +" ms \n";
                            fs.appendFileSync(rptFile, buff);
                            if ( latency_orderer[0] > 0 ) {
                                buff = "("+channelName+":"+chaincode_id+"):\tmin: "+ latency_orderer[2] +" ms  max: "+ latency_orderer[3] +" ms  avg: "+ latency_orderer[1]/latency_orderer[0].toFixed(2) +" ms \n";
                                fs.appendFileSync(rptFile, buff);
                            }

                            // event latency output (end-to-end)
                            buff = "("+channelName+":"+chaincode_id+"): event latency stats (end-to-end)\n";
                            fs.appendFileSync(rptFile, buff);
                            buff = "("+channelName+":"+chaincode_id+"):\ttotal transactions: "+ latency_event[0] +"  total time: "+ latency_event[1] +" ms \n";
                            fs.appendFileSync(rptFile, buff);
                            if ( latency_event[0] > 0 ) {
                                buff = "("+channelName+":"+chaincode_id+"):\tmin: "+ latency_event[2] +" ms  max: "+ latency_event[3] +" ms  avg: "+ latency_event[1]/latency_event[0].toFixed(2) +" ms \n\n";
                                fs.appendFileSync(rptFile, buff);
                            }
                        }
                        if (totalQueryTrans>0) {
                            var dur=etmp-stmp;
                            logger.info("Test Summary (%s):Total  QUERY transaction=%d, the Min duration is %d ms,the Max duration is %d ms,Avg duration=%d ms, total throughput=%d TPS", chaincode_id, totalQueryTrans, minQueryDuration, maxQueryDuration, totalQueryTime/procDone,totalQueryTps.toFixed(2));
                            var qTPS=1000*totalQueryTrans/dur;
                            logger.info("Aggregate Test Summary (%s):Total QUERY transaction %d, start %d end %d duration is %d ms, TPS %d", chaincode_id, totalQueryTrans, stmp, etmp, dur, qTPS.toFixed(2));

                            // query transaction output
                            var buff = "======= "+loggerMsg+" Test Summary: executed at " + sTime + " =======\n";
                            fs.appendFileSync(rptFile, buff);
                            buff = "("+channelName+":"+chaincode_id+"): QUERY transaction stats\n";
                            fs.appendFileSync(rptFile, buff);
                            buff = "("+channelName+":"+chaincode_id+"):\tTotal transactions "+totalQueryTrans + "\n";
                            fs.appendFileSync(rptFile, buff);

                            buff = "("+channelName+":"+chaincode_id+"):\tstart "+stmp+"  end "+etmp+"  duration "+dur+" ms \n";
                            fs.appendFileSync(rptFile, buff);
                            buff = "("+channelName+":"+chaincode_id+"):\tTPS "+qTPS.toFixed(2)+ "\n\n";
                            fs.appendFileSync(rptFile, buff);
                        }
                        if (totalMixedTPS) {
                            var dur=etmp-stmp;
                            var mixTotal=totalMixedInvoke+totalMixedQuery;
                            logger.info("Test Summary (%s):Total mixed transaction=%d, the Min duration is %d ms,the Max duration is %d ms,Avg duration=%d ms, total throughput=%d TPS", chaincode_id, mixTotal, minMixedDuration, maxMixedDuration, (totalMixedTime)/(procDone),(totalMixedTPS).toFixed(2));
                            var mTPS=1000*(totalMixedInvoke+totalMixedQuery)/dur;
                            logger.info("Aggregate Test Summary (%s):Total MIX transaction invoke %d query %d total %d, start %d end %d duration is %d ms, TPS %d", chaincode_id, totalMixedInvoke, totalMixedQuery, totalMixedInvoke+totalMixedQuery, stmp, etmp, etmp-stmp, mTPS.toFixed(2));

                            // mix transaction output
                            var buff = "======= "+loggerMsg+" Test Summary: executed at " + sTime + " =======\n";
                            fs.appendFileSync(rptFile, buff);
                            buff = "("+channelName+":"+chaincode_id+"): MIX transaction stats\n";
                            fs.appendFileSync(rptFile, buff);
                            buff = "("+channelName+":"+chaincode_id+"):\tTotal transactions "+mixTotal+" INVOKE "+totalMixedInvoke+"  QUERY "+ totalMixedQuery + "\n";
                            fs.appendFileSync(rptFile, buff);

                            buff = "("+channelName+":"+chaincode_id+"):\tstart "+stmp+"  end "+etmp+"  duration "+dur+" ms \n";
                            fs.appendFileSync(rptFile, buff);
                            buff = "("+channelName+":"+chaincode_id+"):\tTPS "+mTPS.toFixed(2)+ "\n\n";
                            fs.appendFileSync(rptFile, buff);
                        }
                        logger.info('[performance_main] pte-main:completed:');

                    }

                });

            }
        } else {
            logger.error('[Nid=%d] invalid transType: %s', Nid, transType);
        }

    }
}

function readFile(path) {
        return new Promise(function(resolve, reject) {
                fs.readFile(path, function(err, data) {
                        if (err) {
                                reject(err);
                        } else {
                                resolve(data);
                        }
                });
        });
}

function sleep(ms) {
	return new Promise(resolve => setTimeout(resolve, ms));
}

function evtDisconnect(eventHubs, blockCallbacks) {
    if (!eventHubs) {
        eventHubs = allEventhubs;
    }
    for (var i=0; i<eventHubs.length; i++) {
        if (eventHubs[i] && eventHubs[i].isconnected()) {
            logger.info('Disconnecting the event hub: %s', eventHubs[i].getPeerAddr());
            if (blockCallbacks && blockCallbacks[i]) {
                eventHubs[i].unregisterBlockEvent(blockCallbacks[i]);
            }
            eventHubs[i].disconnect();
        }
    }
}
