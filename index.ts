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
import { getAssociatedTokenAddress, getAccount, NATIVE_MINT } from "@solana/spl-token";
import { getBuyTxWithJupiter, getSellTxWithJupiter } from "./utils/swapOnlyAmm";
import { execute, getTokenMarketCap } from "./utils/legacy";
import { executeJitoTx } from "./utils/jito";
import { GRPC_ENDPOINT, PUMPFUN_PROGRAM_ID, RARDIUM_PROGRAM_ID, SOL_MINT, TARGET_ADDRESS, RPC_ENDPOINT, PHOTON_PROGRAM_ID, METEORA_PROGRAM_ID, BUY_LIMIT, MAX_RETRY } from "./constants"
import { logger } from "./utils";
import { buyTokenPumpfun } from "./pumpfun/transaction/buyTokenPump";
import sellTokenPumpfun, { sellWithJupiter } from "./pumpfun/transaction/sellTokenPump";
import sellToken, { getSellPrice } from "./pumpfun/transaction/sellToken";
import { sleep } from "./pumpfun/src/utils";
import { sellAllToken } from "./utils/gatherrefer";
dotenv.config()


const title = `
                                           ██████╗ ██╗   ██╗███╗   ███╗██████╗            ███████╗██╗   ██╗███╗   ██╗
                                           ██╔══██╗██║   ██║████╗ ████║██╔══██╗           ██╔════╝██║   ██║████╗  ██║
                                           ██████╔╝██║   ██║██╔████╔██║██████╔╝           █████╗  ██║   ██║██╔██╗ ██║
                                           ██╔═══╝ ██║   ██║██║╚██╔╝██║██╔═══╝            ██╔══╝  ██║   ██║██║╚██╗██║
                                           ██║     ╚██████╔╝██║ ╚═╝ ██║██║         ██╗    ██║     ╚██████╔╝██║ ╚████║
                                           ╚═╝      ╚═════╝ ╚═╝     ╚═╝╚═╝         ╚═╝    ╚═╝      ╚═════╝ ╚═╝  ╚═══╝
                                                                          

 ██████╗ ██████╗ ██████╗ ██╗   ██╗    ████████╗██████╗  █████╗ ██████╗ ██╗███╗   ██╗ ██████╗               ███████╗███╗   ██╗██╗██████╗ ███████╗██████╗ 
██╔════╝██╔═══██╗██╔══██╗╚██╗ ██╔╝    ╚══██╔══╝██╔══██╗██╔══██╗██╔══██╗██║████╗  ██║██╔════╝     ▄ ██╗▄    ██╔════╝████╗  ██║██║██╔══██╗██╔════╝██╔══██╗
██║     ██║   ██║██████╔╝ ╚████╔╝        ██║   ██████╔╝███████║██║  ██║██║██╔██╗ ██║██║  ███╗     ████╗    ███████╗██╔██╗ ██║██║██████╔╝█████╗  ██████╔╝
██║     ██║   ██║██╔═══╝   ╚██╔╝         ██║   ██╔══██╗██╔══██║██║  ██║██║██║╚██╗██║██║   ██║    ▀╚██╔▀    ╚════██║██║╚██╗██║██║██╔═══╝ ██╔══╝  ██╔══██╗
╚██████╗╚██████╔╝██║        ██║          ██║   ██║  ██║██║  ██║██████╔╝██║██║ ╚████║╚██████╔╝      ╚═╝     ███████║██║ ╚████║██║██║     ███████╗██║  ██║
 ╚═════╝ ╚═════╝ ╚═╝        ╚═╝          ╚═╝   ╚═╝  ╚═╝╚═╝  ╚═╝╚═════╝ ╚═╝╚═╝  ╚═══╝ ╚═════╝               ╚══════╝╚═╝  ╚═══╝╚═╝╚═╝     ╚══════╝╚═╝  ╚═╝
                                                                                                                                                                       
 
                     ██╗ ██████╗ ██████╗ ██████╗  ██████╗██╗               ███████╗██████╗ ██╗██╗  ██╗███████╗ ██████╗ ██╗     ██╗ ██╗ ██████╗ 
                    ██╔╝██╔════╝ ██╔══██╗██╔══██╗██╔════╝╚██╗              ██╔════╝██╔══██╗██║██║ ██╔╝██╔════╝██╔═══██╗██║    ███║███║██╔════╝ 
                    ██║ ██║  ███╗██████╔╝██████╔╝██║      ██║    █████╗    █████╗  ██████╔╝██║█████╔╝ ███████╗██║   ██║██║    ╚██║╚██║███████╗ 
                    ██║ ██║   ██║██╔══██╗██╔═══╝ ██║      ██║    ╚════╝    ██╔══╝  ██╔══██╗██║██╔═██╗ ╚════██║██║   ██║██║     ██║ ██║██╔═══██╗
                    ╚██╗╚██████╔╝██║  ██║██║     ╚██████╗██╔╝              ███████╗██║  ██║██║██║  ██╗███████║╚██████╔╝███████╗██║ ██║╚██████╔╝
                     ╚═╝ ╚═════╝ ╚═╝  ╚═╝╚═╝      ╚═════╝╚═╝               ╚══════╝╚═╝  ╚═╝╚═╝╚═╝  ╚═╝╚══════╝ ╚═════╝ ╚══════╝╚═╝ ╚═╝ ╚═════╝ 
                                                                                                                                                                
-------------------------------------------------------------                 Version 1.0                 ----------------------------------------------------------------

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
const boughtTokens: string[] = [];
async function handleData(data: SubscribeUpdate, stream: ClientDuplexStream<SubscribeRequest, SubscribeUpdate>) {


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
            isStopped = true;
            console.log("======================== Pumpfun trading transaction ======================== ");

            if (transaction.meta?.logMessages.map(str => str.includes("Buy")).includes(true)) {
                let buySolAmount;
                let tokenMint;
                try {

                    console.log("======================== Buy token transaction from Pumpfun ======================== ")
                    saveToJSONFile("Pump-buy.json", data);

                    let solPumpfunBuyAmount = (Number(transaction.meta.postBalances[3]) - Number(transaction.meta.preBalances[3])) / (10 ** 9);


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
                    if (boughtTokens.includes(mintAddress)) {
                        console.log(`Skipping buy. Already purchased token: ${mintAddress}`);

                    } else {
                        // **Check if the token has already been bought**

                        if (!tokenDecimal) {
                            console.log("No valid token mint address found.");
                            return;
                        }
                        console.log("mintAddress===>", mintAddress);

                        let solBalanceBeforeBuy = await solanaConnection.getBalance(keyPair.publicKey);

                        let buyPumpfunResult = await buyTokenPumpfun(new PublicKey(mintAddress), solPumpfunBuyAmount);

                        let solBalanceAfterBuy = await solanaConnection.getBalance(keyPair.publicKey);

                        buySolAmount = (solBalanceBeforeBuy - solBalanceAfterBuy - (0.000105 + 0.000005 + 0.00203928 + 0.00001003) * 10 ** 9);
                        tokenMint = mintAddress
                        try {

                            let tokenAccountInfo: any;
                            const maxRetries = MAX_RETRY;
                            const delayBetweenRetries = 20; // 20m seconds delay between retries

                            logger.info('Start get token ata');
                            const tokenAta = await getAssociatedTokenAddress(new PublicKey(tokenMint), keyPair.publicKey, false);
                            logger.info('Finish get token ata');

                            for (let attempt = 0; attempt < maxRetries; attempt++) {
                                try {
                                    tokenAccountInfo = await getAccount(solanaConnection, tokenAta);
                                    break; // Break the loop if fetching the account was successful
                                } catch (error) {
                                    if (error instanceof Error && error.name === 'TokenAccountNotFoundError') {
                                        logger.info(`Attempt ${attempt + 1}/${maxRetries}: Associated token account not found, retrying...`);
                                        if (attempt === maxRetries - 1) {
                                            logger.error(`Max retries reached. Failed to fetch the token account.`);
                                            throw error;
                                        }
                                        // Wait before retrying
                                        await new Promise((resolve) => setTimeout(resolve, delayBetweenRetries));
                                    } else if (error instanceof Error) {
                                        logger.error(`Unexpected error while fetching token account: ${error.message}`);
                                        throw error;
                                    } else {
                                        logger.error(`An unknown error occurred: ${String(error)}`);
                                        throw error;
                                    }
                                }
                            }

                            // const tokenAta = await getAssociatedTokenAddress(tokenMint, keyPair.publicKey);
                            // const tokenAccountInfo = await getAccount(solanaConnection, tokenAta);
                            // console.log("🚀 ~ tokenInfo:", tokenAccountInfo);
                            // console.log("🚀 ~ tokenBalance:", tokenAccountInfo.amount);

                            if (Number(tokenAccountInfo?.amount) !== 0) {
                                console.log("Token balance is updated successfully", '\n');
                                console.log("Token price after buy===>", tokenAccountInfo.amount)

                                // **Add token to the bought list**
                                boughtTokens.push(mintAddress);
                                console.log("Updated mintAddresses:", boughtTokens);

                                //start sell function
                                let buyPrice = Number(buySolAmount) / Number(tokenAccountInfo.amount);
                                let sellTokenSig = await sellToken(new PublicKey(tokenMint), buyPrice);
                                console.log("sellSig====>", sellTokenSig, '\n')
                                if (sellTokenSig) {
                                    await sleep(2000);
                                }
                                else {
                                    await sellToken(new PublicKey(tokenMint), buyPrice);
                                    await sellWithJupiter(new PublicKey(tokenMint))

                                }
                                isStopped = false;

                                return true; // Token balance is updated successfully

                            } else {
                                console.log("Token balance is not updated", '\n');
                                return false; // Token balance is not updated
                            }


                        } catch (error) {
                            console.log(error)
                            console.log("--------------------- Pumpfun transactio fail ---------------------")
                        }
                    }
                } catch (error) {
                    console.log(error);
                    console.log("--------------------- Pumpfun transactio fail ---------------------")
                }
            }
            isStopped = false;
        }
        else if (transaction.meta?.logMessages.map(str => str.includes(PHOTON_PROGRAM_ID)).includes(true)) {
            isStopped = true;
            console.log("======================== Photon trading transaction ======================== ");

            if (transaction.meta?.logMessages.map(str => str.includes("Buy")).includes(true)) {
                let buySolAmount;
                let tokenMint;
                try {

                    console.log("======================== Buy token transaction from Photon ======================== ")
                    saveToJSONFile("Photon-buy.json", data);

                    let solPumpfunBuyAmount = (Number(transaction.meta.postBalances[3]) - Number(transaction.meta.preBalances[3])) / (10 ** 9);

                    let mintAddress = transaction.meta.preTokenBalances[0].mint;
                    console.log("solPumpfunBuyAmount=>", solPumpfunBuyAmount);
                    console.log("mintaddress=>", mintAddress);


                    let solBalanceBeforeBuy = await solanaConnection.getBalance(keyPair.publicKey);

                    let buyPumpfunResult = await buyTokenPumpfun(new PublicKey(mintAddress), solPumpfunBuyAmount);

                    let solBalanceAfterBuy = await solanaConnection.getBalance(keyPair.publicKey);

                    buySolAmount = (solBalanceBeforeBuy - solBalanceAfterBuy - (0.000105 + 0.000005 + 0.00203928 + 0.00001003) * 10 ** 9);
                    tokenMint = mintAddress
                    try {


                        let tokenAccountInfo: any;
                        const maxRetries = MAX_RETRY;
                        const delayBetweenRetries = 20; // 20m seconds delay between retries

                        logger.info('Start get token ata');
                        const tokenAta = await getAssociatedTokenAddress(new PublicKey(tokenMint), keyPair.publicKey, false);
                        logger.info('Finish get token ata');

                        for (let attempt = 0; attempt < maxRetries; attempt++) {
                            try {
                                tokenAccountInfo = await getAccount(solanaConnection, tokenAta);
                                break; // Break the loop if fetching the account was successful
                            } catch (error) {
                                if (error instanceof Error && error.name === 'TokenAccountNotFoundError') {
                                    logger.info(`Attempt ${attempt + 1}/${maxRetries}: Associated token account not found, retrying...`);
                                    if (attempt === maxRetries - 1) {
                                        logger.error(`Max retries reached. Failed to fetch the token account.`);
                                        throw error;
                                    }
                                    // Wait before retrying
                                    await new Promise((resolve) => setTimeout(resolve, delayBetweenRetries));
                                } else if (error instanceof Error) {
                                    logger.error(`Unexpected error while fetching token account: ${error.message}`);
                                    throw error;
                                } else {
                                    logger.error(`An unknown error occurred: ${String(error)}`);
                                    throw error;
                                }
                            }
                        }


                        // const tokenAta = await getAssociatedTokenAddress(new PublicKey(tokenMint), keyPair.publicKey);
                        // const tokenAccountInfo = await getAccount(solanaConnection, tokenAta);
                        // console.log("🚀 ~ tokenInfo:", tokenAccountInfo);
                        // console.log("🚀 ~ tokenBalance:", tokenAccountInfo.amount);

                        if (Number(tokenAccountInfo?.amount) !== 0) {
                            console.log("Token balance is updated successfully", '\n');

                            //start sell function
                            let buyPrice = Number(buySolAmount) / Number(tokenAccountInfo.amount);
                            let sellTokenSig = await sellToken(new PublicKey(tokenMint), buyPrice);

                            console.log("sellSig====>", sellTokenSig, '\n')
                            if (sellTokenSig) {
                                await sleep(2000);
                            }
                            else {
                                await sellToken(new PublicKey(tokenMint), buyPrice);
                                await sellWithJupiter(new PublicKey(tokenMint))

                            }
                            isStopped = false;

                            return true; // Token balance is updated successfully

                        } else {
                            console.log("Token balance is not updated", '\n');
                            return false; // Token balance is not updated
                        }


                    } catch (error) {
                        console.log(error)
                        console.log("--------------------- Pumpfun transactio fail ---------------------")
                    }

                } catch (error) {
                    console.log(error)
                    console.log("--------------------- Pumpfun transactio fail ---------------------")
                }

            }
            isStopped = false;
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

export const runBot = () => {
    main().catch((err) => {
        console.error('Unhandled error in main:', err);
        process.exit(1);
    });

}

runBot();