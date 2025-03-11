import { ComputeBudgetProgram, Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, VersionedTransaction, sendAndConfirmTransaction } from "@solana/web3.js"
import { TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, createCloseAccountInstruction, createTransferCheckedInstruction, getAssociatedTokenAddress } from "@solana/spl-token";
import { SPL_ACCOUNT_LAYOUT, TokenAccount } from "@raydium-io/raydium-sdk";
import base58 from "bs58"
import dotenv from 'dotenv';

import { sleep } from "./commonFunc";

dotenv.config()

const RPC_ENDPOINT = process.env.RPC_ENDPOINT;
const RPC_WEBSOCKET_ENDPOINT = process.env.WEBSOCKET_RPC_ENDPOINT;
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const GATHER_SLIPPAGE = Number(process.env.GATHER_SLIPPAGE);
const GATHER_FEE_LEVEL = Number(process.env.GATHER_FEE_LEVEL);

const connection = new Connection(RPC_ENDPOINT!, { wsEndpoint: RPC_WEBSOCKET_ENDPOINT, commitment: "confirmed" });
const mainKp = Keypair.fromSecretKey(base58.decode(PRIVATE_KEY!))

export const sellAllToken = async () => {

    try {
        const solBalance = await connection.getBalance(mainKp.publicKey)
        if (solBalance > 0)
            console.log("Wallet ", mainKp.publicKey.toBase58(), " SOL balance is ", (solBalance / 10 ** 9).toFixed(4))

        const tokenAccounts = await connection.getTokenAccountsByOwner(mainKp.publicKey, {
            programId: TOKEN_PROGRAM_ID,
        },
            "confirmed"
        )

        const ixs: TransactionInstruction[] = []
        const accounts: TokenAccount[] = [];
        console.log("Token Account counts:", tokenAccounts.value.length)

        if (tokenAccounts.value.length > 0)
            for (const { pubkey, account } of tokenAccounts.value) {
                accounts.push({
                    pubkey,
                    programId: account.owner,
                    accountInfo: SPL_ACCOUNT_LAYOUT.decode(account.data),
                });
            }

        for (let j = 0; j < accounts.length; j++) {
            const baseAta = await getAssociatedTokenAddress(accounts[j].accountInfo.mint, mainKp.publicKey)
            const tokenAccount = accounts[j].pubkey
            const tokenBalance = (await connection.getTokenAccountBalance(accounts[j].pubkey)).value
            console.log("Token balance : ", tokenBalance.uiAmount)

            let i = 0
            while (true) {
                if (i > 5) {
                    console.log("Sell error")
                    break
                }
                if (tokenBalance.uiAmount == 0) {
                    break
                }
                try {
                    const sellTx = await getSellTxWithJupiter(mainKp, accounts[j].accountInfo.mint, tokenBalance.amount)
                    if (sellTx == null) {
                        throw new Error("Error getting sell tx")
                    }
                    const latestBlockhashForSell = await connection.getLatestBlockhash()
                    const txSellSig = await execute(sellTx, latestBlockhashForSell, false)
                    const tokenSellTx = txSellSig ? `https://solscan.io/tx/${txSellSig}` : ''
                    console.log("Sold token, ", tokenSellTx)
                    break
                } catch (error) {
                    i++
                }
            }
            await sleep(1000)

            const tokenBalanceAfterSell = (await connection.getTokenAccountBalance(accounts[j].pubkey)).value
            if (tokenBalanceAfterSell.uiAmount && tokenBalanceAfterSell.uiAmount > 0) {
                console.log("Token Balance After Sell:", mainKp.publicKey.toBase58(), tokenBalanceAfterSell.amount)
                ixs.push(createAssociatedTokenAccountIdempotentInstruction(mainKp.publicKey, baseAta, mainKp.publicKey, accounts[j].accountInfo.mint))
                ixs.push(createTransferCheckedInstruction(tokenAccount, accounts[j].accountInfo.mint, baseAta, mainKp.publicKey, BigInt(tokenBalanceAfterSell.amount), tokenBalance.decimals))
            }
            ixs.push(createCloseAccountInstruction(tokenAccount, mainKp.publicKey, mainKp.publicKey))
        }

        if (ixs.length) {
            const tx = new Transaction().add(
                ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 500_000 }),
                ComputeBudgetProgram.setComputeUnitLimit({ units: 40_000 }),
                ...ixs,
            )
            tx.feePayer = mainKp.publicKey
            tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash
            console.log(await connection.simulateTransaction(tx), '\n')

            const sig = await sendAndConfirmTransaction(connection, tx, [mainKp, mainKp], { commitment: "confirmed" })
            console.log(`Closed and sold tokens from wallet : https://solscan.io/tx/${sig}`)
            return
        }


    } catch (error) {
        console.log("transaction error while processing", error)
        return
    }
}


const getSellTxWithJupiter = async (wallet: Keypair, baseMint: PublicKey, amount: string) => {
    try {
        const quoteResponse = await (
            await fetch(
                `https://quote-api.jup.ag/v6/quote?inputMint=${baseMint.toBase58()}&outputMint=So11111111111111111111111111111111111111112&amount=${amount}&slippageBps=${GATHER_SLIPPAGE}`
            )
        ).json();

        // get serialized transactions for the swap
        const { swapTransaction } = await (
            await fetch("https://quote-api.jup.ag/v6/swap", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    quoteResponse,
                    userPublicKey: wallet.publicKey.toString(),
                    wrapAndUnwrapSol: true,
                    dynamicComputeUnitLimit: true,
                    prioritizationFeeLamports: 5_000 * GATHER_FEE_LEVEL
                }),
            })
        ).json();

        // deserialize the transaction
        const swapTransactionBuf = Buffer.from(swapTransaction, "base64");
        const transaction = VersionedTransaction.deserialize(swapTransactionBuf);

        // sign the transaction
        transaction.sign([wallet]);
        return transaction
    } catch (error) {
        console.log("Failed to get sell transaction")
        return null
    }
};



interface Blockhash {
    blockhash: string;
    lastValidBlockHeight: number;
}

export const execute = async (transaction: VersionedTransaction, latestBlockhash: Blockhash, isBuy: boolean | 1 = true) => {

    const signature = await connection.sendRawTransaction(transaction.serialize(), { skipPreflight: true })
    const confirmation = await connection.confirmTransaction(
        {
            signature,
            lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
            blockhash: latestBlockhash.blockhash,
        }
    );

    if (confirmation.value.err) {
        console.log("Confirmation error")
        return ""
    } else {
        if (isBuy === 1) {
            return signature
        } else if (isBuy)
            console.log(`Success in buy transaction: https://solscan.io/tx/${signature}`)
        else
            console.log(`Success in Sell transaction: https://solscan.io/tx/${signature}`)
    }
    return signature
}


