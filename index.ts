import Client, {
    CommitmentLevel,
    SubscribeRequest,
    SubscribeUpdate,
    SubscribeUpdateTransaction,
} from "@triton-one/yellowstone-grpc";
import { CompiledInstruction } from "@triton-one/yellowstone-grpc/dist/grpc/solana-storage";
import { ClientDuplexStream } from '@grpc/grpc-js';
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import dotenv from 'dotenv';
import fs from 'fs';
import { convertBuffers } from "./utils/geyser";
// import { JUP_AGGREGATOR, USDC_MINT_ADDRESS } from "./constants";
import { getAssociatedTokenAddress, NATIVE_MINT } from "@solana/spl-token";
import { getBuyTxWithJupiter, getSellTxWithJupiter } from "./utils/swapOnlyAmm";
import { execute, getTokenMarketCap } from "./utils/legacy";
import { executeJitoTx } from "./utils/jito";
import { GRPC_ENDPOINT, PUMPFUN_PROGRAM_ID, RARDIUM_PROGRAM_ID, SOL_MINT, TARGET_ADDRESS, RPC_ENDPOINT, PHOTON_PROGRAM_ID, METEORA_PROGRAM_ID } from "./constants"
import { logger } from "./utils";
import { buyTokenPumpfun } from "./pumpfun/transaction/buyTokenPump";
import sellTokenPumpfun from "./pumpfun/transaction/sellTokenPump";

dotenv.config()


const title = `
 ██████╗ ██████╗ ██████╗ ██╗   ██╗    ████████╗██████╗  █████╗ ██████╗ ██╗███╗   ██╗ ██████╗     ██████╗  ██████╗ ████████╗
██╔════╝██╔═══██╗██╔══██╗╚██╗ ██╔╝    ╚══██╔══╝██╔══██╗██╔══██╗██╔══██╗██║████╗  ██║██╔════╝     ██╔══██╗██╔═══██╗╚══██╔══╝
██║     ██║   ██║██████╔╝ ╚████╔╝        ██║   ██████╔╝███████║██║  ██║██║██╔██╗ ██║██║  ███╗    ██████╔╝██║   ██║   ██║   
██║     ██║   ██║██╔═══╝   ╚██╔╝         ██║   ██╔══██╗██╔══██║██║  ██║██║██║╚██╗██║██║   ██║    ██╔══██╗██║   ██║   ██║   
╚██████╗╚██████╔╝██║        ██║          ██║   ██║  ██║██║  ██║██████╔╝██║██║ ╚████║╚██████╔╝    ██████╔╝╚██████╔╝   ██║   
 ╚═════╝ ╚═════╝ ╚═╝        ╚═╝          ╚═╝   ╚═╝  ╚═╝╚═╝  ╚═╝╚═════╝ ╚═╝╚═╝  ╚═══╝ ╚═════╝     ╚═════╝  ╚═════╝    ╚═╝   

 
                                   ██╗     ██████╗     ██████╗     ██████╗      ██████╗    ██╗ 
                                  ██╔╝    ██╔════╝     ██╔══██╗    ██╔══██╗    ██╔════╝    ╚██╗
                                  ██║     ██║  ███╗    ██████╔╝    ██████╔╝    ██║          ██║
                                  ██║     ██║   ██║    ██╔══██╗    ██╔═══╝     ██║          ██║
                                  ╚██╗    ╚██████╔╝    ██║  ██║    ██║         ╚██████╗    ██╔╝
                                   ╚═╝     ╚═════╝     ╚═╝  ╚═╝    ╚═╝          ╚═════╝    ╚═╝ 
                                                                                                                                                            
-------------------------------------------------------- Version 3.0 --------------------------------------------------------

`;


console.log(title, '\n');

// Constants
const COMMITMENT = CommitmentLevel.PROCESSED;
const IS_JITO = process.env.IS_JITO!;

const solanaConnection = new Connection(RPC_ENDPOINT, 'confirmed');
const keyPair = Keypair.fromSecretKey(bs58.decode(process.env.PRIVATE_KEY!));

if (!TARGET_ADDRESS) console.log('Target Address is not defined')

console.log('========================================= Your Config =======================================', '\n');
console.log('Target Wallet Address =====> ', TARGET_ADDRESS, '\n');
console.log("Bot Wallet Address    =====> ", keyPair.publicKey.toBase58(), '\n');
console.log('=============================================================================================== \n');

// Main function
async function main(): Promise<void> {
    const client = new Client(GRPC_ENDPOINT, undefined, {});
    const stream = await client.subscribe();
    const request = createSubscribeRequest();

    try {
        await sendSubscribeRequest(stream, request);
        console.log(`Geyser connection established - watching ${TARGET_ADDRESS} \n`);
        await handleStreamEvents(stream);
    } catch (error) {
        console.error('Error in subscription process:', error);
        stream.end();
    }
}

// Helper functions
function createSubscribeRequest(): SubscribeRequest {
    return {
        accounts: {},
        slots: {},
        transactions: {
            client: {
                accountInclude: [],
                accountExclude: [],
                accountRequired: [TARGET_ADDRESS],
                failed: false
            }
        },
        transactionsStatus: {},
        entry: {},
        blocks: {},
        blocksMeta: {},
        commitment: COMMITMENT,
        accountsDataSlice: [],
        ping: undefined,
    };
}

function sendSubscribeRequest(
    stream: ClientDuplexStream<SubscribeRequest, SubscribeUpdate>,
    request: SubscribeRequest
): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        stream.write(request, (err: Error | null) => {
            if (err) {
                reject(err);
            } else {
                resolve();
            }
        });
    });
}


function handleStreamEvents(stream: ClientDuplexStream<SubscribeRequest, SubscribeUpdate>): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        stream.on('data', async (data) => {
            await handleData(data, stream)
        });
        stream.on("error", (error: Error) => {
            console.error('Stream error:', error);
            reject(error);
            stream.end();
        });
        stream.on("end", () => {
            console.log('Stream ended');
            resolve();
        });
        stream.on("close", () => {
            console.log('Stream closed');
            resolve();
        });
    });
}


let isStopped = false;

async function handleData(data: SubscribeUpdate, stream: ClientDuplexStream<SubscribeRequest, SubscribeUpdate>) {

    isStopped = true;
    if (isStopped) {
        return; // Skip processing if the stream is stopped
    }

    try {

        if (!isSubscribeUpdateTransaction(data)) {
            return;
        }

        logger.info('Start filter');

        const transaction = data.transaction?.transaction;
        const message = transaction?.transaction?.message;

        if (!transaction || !message) {
            return;
        }

        const formattedSignature = convertSignature(transaction.signature);
        console.log('========================================= Target Wallet =======================================');
        console.log("Signature => ", `https://solscan.io/tx/${formattedSignature.base58}`);
        // console.log('message==========>', message);
        saveToJSONFile("Transactions.json", data);


        if (transaction.meta?.logMessages.map(str => str.includes(PUMPFUN_PROGRAM_ID)).includes(true)) {

            console.log("======================== Pumpfun trading transaction ======================== ");

            if (transaction.meta?.logMessages.map(str => str.includes("Buy")).includes(true)) {

                try {

                    console.log("======================== Buy token transaction from Pumpfun ======================== ")
                    saveToJSONFile("Pump-buy.json", data);

                    let solPumpfunBuyAmount = (Number(transaction.meta.postBalances[3]) - Number(transaction.meta.preBalances[3])) / (10 ** 9);

                    // let mintAddress = transaction.meta.preTokenBalances[0].mint;
                    // console.log("solPumpfunBuyAmount=>", solPumpfunBuyAmount);
                    // console.log("mintaddress=>", mintAddress);


                    const mintAddress = transaction.meta.preTokenBalances.find(
                        (b) => b.mint !== SOL_MINT
                    )?.mint;

                    const tokenDecimal = transaction.meta.preTokenBalances.find(
                        (b) => b.mint !== SOL_MINT
                    )?.uiTokenAmount?.decimals

                    if (!mintAddress) {
                        console.log("No valid token mint address found.");
                        return;
                    }
                    if (!tokenDecimal) {
                        console.log("No valid token mint address found.");
                        return;
                    }
                    console.log("mintAddress===>", mintAddress);

                    let buyPumpfunResult = await buyTokenPumpfun(new PublicKey(mintAddress), solPumpfunBuyAmount);

                    // if (buyPumpfunResult) {
                    //     console.log("Success buy token in Pumpfun")
                    // }

                } catch (error) {
                    console.log(error)
                    console.log("Fail buy token in Pumpfun")
                }

            } else if (transaction.meta?.logMessages.map(str => str.includes("Sell")).includes(true)) {

                try {

                    console.log("======================== Sell token transaction to Pumpfun ======================== ")
                    saveToJSONFile("Pump-sell.json", data);

                    const mintAddress = transaction.meta.preTokenBalances[0]?.mint;
                    console.log("mintAddress===>", mintAddress)

                    const preBalance = transaction.meta?.preTokenBalances.find(
                        (b) => b.mint == mintAddress && b.owner == TARGET_ADDRESS
                    )?.uiTokenAmount?.uiAmount || 0;

                    const postBalance = transaction.meta?.postTokenBalances?.find(
                        (b) => b.mint == mintAddress && b.owner == TARGET_ADDRESS
                    )?.uiTokenAmount?.uiAmount || 0;

                    const tokenPumpfunSellAmount = preBalance - postBalance;

                    console.log("tokenPumpfunSellAmount============>", tokenPumpfunSellAmount);

                    let sellPumpfunResult = await sellTokenPumpfun(new PublicKey(mintAddress), tokenPumpfunSellAmount)
                    // if (sellPumpfunResult) {
                    //     console.log("Success sell token in Pumpfun")

                    // } else {

                    await sellWithJupiter(new PublicKey(mintAddress));
                    // }
                } catch (error) {
                    console.log(error)
                    console.log("Fail sell token in Pumpfun")
                }

            }
        } else if (transaction.meta?.logMessages.map(str => str.includes(PHOTON_PROGRAM_ID)).includes(true)) {

            console.log("======================== Photon trading transaction ======================== ");

            if (transaction.meta?.logMessages.map(str => str.includes("Buy")).includes(true)) {

                try {

                    console.log("======================== Buy token transaction from Photon ======================== ")
                    saveToJSONFile("Photon-buy.json", data);

                    let solPumpfunBuyAmount = (Number(transaction.meta.postBalances[3]) - Number(transaction.meta.preBalances[3])) / (10 ** 9);

                    let mintAddress = transaction.meta.preTokenBalances[0].mint;
                    console.log("solPumpfunBuyAmount=>", solPumpfunBuyAmount);
                    console.log("mintaddress=>", mintAddress);
                    let buyPumpfunResult = await buyTokenPumpfun(new PublicKey(mintAddress), solPumpfunBuyAmount);

                    if (buyPumpfunResult) {
                        console.log("Success buy token in Pumpfun")
                    }

                } catch (error) {
                    console.log(error)
                    console.log("Fail buy token in Pumpfun")
                }

            } else if (transaction.meta?.logMessages.map(str => str.includes("Sell")).includes(true)) {

                try {

                    console.log("======================== Sell token transaction to Photon ======================== ")
                    saveToJSONFile("Photon-sell.json", data);

                    const mintAddress = transaction.meta.preTokenBalances[0]?.mint;
                    console.log("mintAddress===>", mintAddress)

                    const preBalance = transaction.meta?.preTokenBalances.find(
                        (b) => b.mint == mintAddress && b.owner == TARGET_ADDRESS
                    )?.uiTokenAmount?.uiAmount || 0;

                    const postBalance = transaction.meta?.postTokenBalances?.find(
                        (b) => b.mint == mintAddress && b.owner == TARGET_ADDRESS
                    )?.uiTokenAmount?.uiAmount || 0;

                    const tokenPumpfunSellAmount = preBalance - postBalance;

                    console.log("tokenPumpfunSellAmount============>", tokenPumpfunSellAmount);

                    let sellPumpfunResult = await sellTokenPumpfun(new PublicKey(mintAddress), tokenPumpfunSellAmount)
                    // if (sellPumpfunResult) {
                    //     console.log("Success sell token in Pumpfun")

                    // } else {

                    await sellWithJupiter(new PublicKey(mintAddress));
                    // }
                } catch (error) {
                    console.log(error)
                    console.log("Fail sell token in Pumpfun")
                }

            }
        }


    } catch (error) {
        console.log(error)
    }

}

function isSubscribeUpdateTransaction(data: SubscribeUpdate): data is SubscribeUpdate & { transaction: SubscribeUpdateTransaction } {
    return (
        'transaction' in data &&
        typeof data.transaction === 'object' &&
        data.transaction !== null &&
        'slot' in data.transaction &&
        'transaction' in data.transaction
    );
}

function convertSignature(signature: Uint8Array): { base58: string } {
    return { base58: bs58.encode(Buffer.from(signature)) };
}

export const saveToJSONFile = (filePath: string, data: object): boolean => {
    // Convert data object to JSON string
    const jsonData = JSON.stringify(data, null, 2);  // The `null, 2` argument formats the JSON with indentation
    fs.writeFileSync(filePath, jsonData, 'utf8');
    console.log('Data saved to JSON file.');
    return true;
};

main().catch((err) => {
    console.error('Unhandled error in main:', err);
    process.exit(1);
});
