import { createCloseAccountInstruction, getAssociatedTokenAddress } from "@solana/spl-token";
import { ComputeBudgetProgram, Connection, Keypair, PublicKey, Transaction, TransactionMessage } from "@solana/web3.js";
import dotenv from 'dotenv'
import BN from "bn.js";
import { PumpFunSDK } from "../src/src/pumpfun";
import { AnchorProvider, web3 } from "@coral-xyz/anchor";
import NodeWallet from "@coral-xyz/anchor/dist/cjs/nodewallet";
import { sendAndConfirmTransaction } from "@solana/web3.js";
import base58 from "bs58";
import { executeJitoTx } from "../../utils/jito";

dotenv.config()



const AUTO_SELL = process.env.AUTO_SELL
const PRIVATE_KEY = process.env.PRIVATE_KEY
const RPC_ENDPOINT = process.env.RPC_ENDPOINT
const RPC_WEBSOCKET_ENDPOINT = process.env.RPC_WEBSOCKET_ENDPOINT;
const take_profit = Number(process.env.TAKE_PROFIT);
const stop_loss = Number(process.env.STOP_LOSS);
const sell_slippage = Number(process.env.SELL_SLIPPAGE);
const skip_selling_if_lost_more_than = Number(process.env.SKIP_SELLING_IF_LOST_MORE_THAN);
const max_sell_retries = Number(process.env.MAX_SELL_RETRIES);
const price_check_interval = Number(process.env.PRICE_CHECK_INTERVAL);
const price_check_duration = Number(process.env.PRICE_CHECK_DURATION);


const commitment = "confirmed"
const solanaConnection = new Connection(process.env.RPC_ENDPOINT!, 'processed');
let sdk = new PumpFunSDK(new AnchorProvider(solanaConnection, new NodeWallet(new Keypair()), { commitment }));
const mainKp = Keypair.fromSecretKey(base58.decode(PRIVATE_KEY!))

async function sellToken(mint: PublicKey, buyPrice: number) {

    if (!AUTO_SELL) {
        console.log("Auto sell is disabled");
        return;
    }

    let retries = 0;
    let startTime = Date.now();
    let price = await getSellPrice(mint);

    while (true) {
        try {
            price = await getSellPrice(mint);
            console.log("token price after buy==>", price);
            const priceChange = ((price - buyPrice) / buyPrice) * 100;
            console.log("priceChange =====>", priceChange);

            console.log(`Current price: ${price}, Buy price: ${buyPrice}, Price change: ${priceChange.toFixed(3)}%`);

            if (priceChange >= take_profit) {
                console.log("Take profit condition met");
                break;
            }
            // if (priceChange <= -stop_loss) {
            //     console.log("Stop loss condition met");
            //     break;
            // }
            // if (priceChange <= -skip_selling_if_lost_more_than) {
            //     console.log(`Skip selling, price drop exceeded threshold: ${skip_selling_if_lost_more_than}%`);
            //     return;
            // }
            if (price_check_duration && Date.now() - startTime > price_check_duration) {
                console.log("Price check duration exceeded, proceeding to sell");
                break;
            }
            await new Promise(resolve => setTimeout(resolve, price_check_interval));
        } catch (error) {
            console.log("Error in price monitoring", error);
        }
    }

    while (retries < max_sell_retries) {
        try {
            console.log(`Attempt ${retries + 1} to sell token`);
            let sellSig = await sell(mint);
            if (sellSig) {
                console.log("Token sold successfully");
                return true;
            }
            break;
        } catch (err) {
            retries++;
            console.log(`Sell attempt failed (${retries}/${max_sell_retries})`, err);
            if (retries >= max_sell_retries) {
                console.log("Max sell retries reached, aborting");
            }
        }
    }
}
export default sellToken;


const sell = async (mint: PublicKey) => {
    try {

        console.log(await solanaConnection.getBalance(mainKp.publicKey) / 10 ** 9, "SOL in main keypair")

        console.log(mint);

        try {
            console.log("======================== Token Sell start =========================")

            const tokenAccount = await getAssociatedTokenAddress(mint, mainKp.publicKey);

            const tokenBalance = (await solanaConnection.getTokenAccountBalance(tokenAccount)).value.amount


            if (tokenBalance) {
                // console.log("tokenBalance", Math.floor(tokenBalance * 10 ** 5));


                const tokenSellix = await makeSellIx(mainKp, Number(tokenBalance), mint)
                console.log(tokenSellix);
                if (!tokenSellix) {
                    console.log("Token buy instruction not retrieved")
                    return
                }

                const tx = new Transaction().add(
                    ComputeBudgetProgram.setComputeUnitPrice({
                        microLamports: 200_000,
                    }),
                    ComputeBudgetProgram.setComputeUnitLimit({
                        units: 300_000,
                    }),
                    tokenSellix,
                    createCloseAccountInstruction(tokenAccount, mainKp.publicKey, mainKp.publicKey)

                )

                tx.feePayer = mainKp.publicKey
                const latestBlockhash = await solanaConnection.getLatestBlockhash();
                tx.recentBlockhash = latestBlockhash.blockhash

                // console.log(await solanaConnection.simulateTransaction(tx), '\n')

                // const signature = await sendAndConfirmTransaction(solanaConnection, tx, [mainKp], { skipPreflight: true, commitment: commitment });

                // console.log(`Sell Tokens : https://solscan.io/tx/${signature}`, '\n')


                const messageV0 = new TransactionMessage({
                    payerKey: mainKp.publicKey,
                    recentBlockhash: tx.recentBlockhash,
                    instructions: tx.instructions,
                }).compileToV0Message()

                const versionedTx = new web3.VersionedTransaction(messageV0);
                versionedTx.sign([mainKp]);
                console.log(await solanaConnection.simulateTransaction(versionedTx, { sigVerify: true }))
                const jitoPromise = executeJitoTx([versionedTx], mainKp, 'processed', latestBlockhash);
                // const sendTransactionPromise = solanaConnection.sendTransaction(
                //     tx,
                //     [mainKp],
                //     { skipPreflight: true, preflightCommitment: 'processed' }
                // );

                // // Run both promises in parallel
                // const [txSig, jitoResult] = await Promise.all([sendTransactionPromise, jitoPromise]);

                // if (jitoResult) {
                //     return jitoResult
                // }

            }

            console.log("======================== Token Sell end ==========================", '\n')
            return true

        } catch (error) {
            console.log("======================== Token Sell fail =========================", '\n')
            return false
        }

    } catch (error) {
        console.log("Token trading error", '\n');
        return false
    }

}


// make sell instructions
const makeSellIx = async (kp: Keypair, sellAmount: number, mint: PublicKey) => {
    let sellIx = await sdk.getSellInstructionsByTokenAmount(
        kp.publicKey,
        mint,
        BigInt(sellAmount),
        BigInt(sell_slippage),
        commitment
    );

    console.log("Sellamount:", sellAmount);

    return sellIx
}

export const getSellPrice = async (mint: PublicKey) => {
    try {
        let bondingCurveAccount = await sdk.getBondingCurveAccount(mint, "processed");
        console.log("bondingCurveAccount==============>", bondingCurveAccount)
        console.log("bondingCurveAccount solreserves==============>", bondingCurveAccount?.virtualSolReserves)
        console.log("bondingCurveAccount tokenreserves==============>", bondingCurveAccount?.virtualTokenReserves)
        if (!bondingCurveAccount) {
            throw new Error(`Bonding curve account not found: ${mint.toBase58()}`);
        }
        return (Number(bondingCurveAccount.virtualSolReserves) / Number(bondingCurveAccount.virtualTokenReserves));
    } catch (err) {
        console.log("Error in sellTokenPrice:", err);
        console.log("Mint address:", mint.toBase58());
        throw err;
    }
}