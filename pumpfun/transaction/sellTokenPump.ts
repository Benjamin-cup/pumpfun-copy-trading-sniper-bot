import { ComputeBudgetProgram, Connection, Keypair, PublicKey, Transaction, TransactionMessage } from "@solana/web3.js";
import { createCloseAccountInstruction, getAccount, getAssociatedTokenAddress } from "@solana/spl-token";
import base58 from "bs58";
import NodeWallet from "@coral-xyz/anchor/dist/cjs/nodewallet";
import { PumpFunSDK } from "../src/src/pumpfun";
import { AnchorProvider, web3 } from "@coral-xyz/anchor";

import dotenv from 'dotenv'
import { MAX_RETRY, PRIVATE_KEY, PUMPFUN_SELL_SLIPPAGE, RPC_ENDPOINT, SELL_PERCENT, SET_COMPUTE_UNIT_LIMIT, SET_COMPUTE_UNITPRICE } from "../../constants";
import { executeJitoTx } from "../utils/jito";
import { logger } from "../src/utils";
import { executeJitoTx1 } from "../../utils/selljito";
import { getSellTxWithJupiter } from "../../utils";
dotenv.config()


const commitment = "confirmed"
const solanaConnection = new Connection(RPC_ENDPOINT, 'processed');
let sdk = new PumpFunSDK(new AnchorProvider(solanaConnection, new NodeWallet(new Keypair()), { commitment }));
const mainKp = Keypair.fromSecretKey(base58.decode(PRIVATE_KEY))


const sellTokenPumpfun = async (mint: PublicKey, sellTokenAmount: number) => {

    try {


        let tokenAccountInfo: any;
        const maxRetries = MAX_RETRY;
        const delayBetweenRetries = 20; // 20m seconds delay between retries

        logger.info('Start get token ata');
        const tokenAta = await getAssociatedTokenAddress(mint, mainKp.publicKey, false);
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

        let tx: Transaction;
        logger.info('Start sell transaction');


        const realTokenBalance = Math.floor(Number(tokenAccountInfo.amount) * (SELL_PERCENT / 100));

        // Fetch the token balance after ensuring the account exists
        const tokenBalance = realTokenBalance.toString();
        logger.info(`Token balance for ${mint.toString()} is: ${tokenBalance}`);

        if (tokenBalance === '0') {
            logger.info({ mint: mint.toString() }, `Empty balance, can't sell`);
            return;
        }

        logger.info('Start make sell instruction');
        const tokenSellix = await makeSellIx(mainKp, Number(tokenBalance), mint);
        logger.info('Finish make sell instruction');

        console.log(tokenSellix);
        if (!tokenSellix) {
            console.log("Token buy instruction not retrieved")
            return
        }
        logger.info('Start building sell transactions');


        if (SELL_PERCENT == 100) {

            tx = new Transaction().add(
                ComputeBudgetProgram.setComputeUnitPrice({
                    microLamports: SET_COMPUTE_UNITPRICE,
                }),
                ComputeBudgetProgram.setComputeUnitLimit({
                    units: SET_COMPUTE_UNIT_LIMIT,
                }),
                tokenSellix,
                createCloseAccountInstruction(tokenAta, mainKp.publicKey, mainKp.publicKey)

            )

        } else {
            tx = new Transaction().add(
                ComputeBudgetProgram.setComputeUnitPrice({
                    microLamports: SET_COMPUTE_UNITPRICE,
                }),
                ComputeBudgetProgram.setComputeUnitLimit({
                    units: SET_COMPUTE_UNIT_LIMIT,
                }),
                tokenSellix,
                // createCloseAccountInstruction(tokenAta, mainKp.publicKey, mainKp.publicKey)

            )

        }

        tx.feePayer = mainKp.publicKey
        const latestBlockhash = await solanaConnection.getLatestBlockhash();
        tx.recentBlockhash = latestBlockhash.blockhash

        const messageV0 = new TransactionMessage({
            payerKey: mainKp.publicKey,
            recentBlockhash: tx.recentBlockhash,
            instructions: tx.instructions,
        }).compileToV0Message()

        const versionedTx = new web3.VersionedTransaction(messageV0);
        versionedTx.sign([mainKp]);
        // console.log(await solanaConnection.simulateTransaction(versionedTx, { sigVerify: true }))
        logger.info('Finish building sell transactions');

        logger.info('Start send and confirm sell transactions');
        const jitoPromise = executeJitoTx([versionedTx], mainKp, 'confirmed', latestBlockhash);
        const sendTransactionPromise = solanaConnection.sendTransaction(
            tx,
            [mainKp],
            { skipPreflight: true, preflightCommitment: 'processed' }
        );

        // Run both promises in parallel
        const [txSig, jitoResult] = await Promise.all([sendTransactionPromise, jitoPromise]);

        if (jitoResult) {
            return jitoResult
        }
        logger.info('Finish sell transactions');
        console.log("======================== Token Sell end ==========================", '\n')
        return true
        // const txSig = await executeJitoTx1([versionedTx], mainKp, "confirmed");
        // console.log(`✅ Successfully swapped tokens. Transaction Signature: ${txSig}`);
        // if (txSig) {
        //     return txSig
        // }
    } catch (error) {
        console.log("======================== Token Sell fail ==========================", '\n')
        console.log(error)
        return false
    }

}

// make sell instructions
const makeSellIx = async (kp: Keypair, sellAmount: number, mint: PublicKey) => {
    let sellIx = await sdk.getSellInstructionsByTokenAmount(
        kp.publicKey,
        mint,
        BigInt(sellAmount),
        BigInt(PUMPFUN_SELL_SLIPPAGE),
        commitment
    );

    console.log("Sellamount:", sellAmount);

    return sellIx
}


export default sellTokenPumpfun;






export async function sellWithJupiter(tokenMint: PublicKey) {
    try {
        console.log("🚀 Initiating Sell Transaction via Jupiter...");

        console.log("tokenMint============>", tokenMint)
        // Ensure wallet is connected
        if (!mainKp?.publicKey) {
            throw new Error("❌ Wallet not connected or undefined.");
        }

        // Fetch associated token account
        const tokenAccount = await getAssociatedTokenAddress(tokenMint, mainKp.publicKey);
        console.log("tokenAccount===========>", tokenAccount);
        // Fetch token balance (as a string)
        const tokenBalanceStr = (await solanaConnection.getTokenAccountBalance(tokenAccount)).value.amount;
        console.log("tokenBalanceStr===========>", tokenBalanceStr);

        // Convert balance to number safely
        const tokenBalance = Number(tokenBalanceStr);
        if (!tokenBalance || tokenBalance <= 0) {
            console.warn("⚠️ No tokens available to sell.");
            return;
        }

        console.log(`📊 Selling ${tokenBalance} tokens...`);

        // Get swap transaction from Jupiter
        const tokenSellTx = await getSellTxWithJupiter(mainKp, tokenMint, tokenBalance);
        if (!tokenSellTx) {
            console.error("❌ Failed to get swap transaction from Jupiter.");
            return;
        }

        // Execute transaction with Jito
        const txSig = await executeJitoTx1([tokenSellTx], mainKp, "confirmed");
        console.log(`✅ Successfully swapped tokens. Transaction Signature: ${txSig}`);
        // await closeAllTokenAccounts()

    } catch (error) {
        console.error("🔥 Error in sellWithJupiter:", error);
    }
}
