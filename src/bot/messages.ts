/**
 * Bot messages.
 *
 * Every message the bot sends to a customer is defined here.
 * Keeping them in one place means:
 *   - Easy to edit wording without touching logic
 *   - Easy to add Shona/Ndebele translations later
 *   - Easy to see the full customer experience at a glance
 *
 * WhatsApp formatting:
 *   *bold*  _italic_  ~strikethrough~
 */

import { PHOTO_PRODUCTS, POSTER_PRODUCTS } from '@/config/catalog.js';
import type { CartItem } from './types.js';

const BUSINESS_NAME = process.env.BUSINESS_NAME ?? 'FusionPrints';
const COLLECTION_ADDRESS =
  process.env.BUSINESS_COLLECTION_ADDRESS ?? 'Collection address TBD, Harare';
const BUSINESS_HOURS = process.env.BUSINESS_HOURS ?? 'Mon–Sat, 9am–6pm';

export const MSG = {
  // ===== Greeting =====

  greeting: (name?: string) =>
    name
      ? `👋 Welcome back, *${name}*!\n\nWhat would you like today?\n\n1️⃣ Photo prints\n2️⃣ Posters\n3️⃣ Check an existing order\n\nReply with a number.`
      : `👋 Welcome to *${BUSINESS_NAME}*!\n\nI print photos and posters — collect in Harare or get them delivered.\n\nWhat would you like today?\n\n1️⃣ Photo prints\n2️⃣ Posters\n3️⃣ Check an existing order\n\nReply with a number.`,

  invalidMenuChoice: () => `Please reply with *1*, *2*, or *3*.`,

  // ===== Product selection =====

  photoSizeMenu: () => {
    const lines = [`Which size?\n`];
    PHOTO_PRODUCTS.forEach((p, i) => {
      lines.push(`${i + 1}️⃣ ${p.displayLabel} — *$${p.unitPriceUsd.toFixed(2)}*`);
    });
    lines.push(`\nReply with a number.`);
    return lines.join('\n');
  },

  posterSizeMenu: () => {
    const lines = [`Which poster size?\n`];
    POSTER_PRODUCTS.forEach((p, i) => {
      const note = p.isOutsourced ? ' _(5–7 day turnaround)_' : '';
      lines.push(`${i + 1}️⃣ ${p.displayLabel} — *$${p.unitPriceUsd.toFixed(2)}*${note}`);
    });
    lines.push(`\nReply with a number.`);
    return lines.join('\n');
  },

  invalidSizeChoice: (max: number) =>
    `Please reply with a number between *1* and *${max}*.`,

  // ===== Image upload =====

  chooseUploadMode: (displayLabel: string, priceEach: string) =>
    `*${displayLabel}* — ${priceEach} each.\n\nHow would you like to send your photos?\n\n1️⃣ *One photo* — multiple copies of the same image\n2️⃣ *A few photos* — send as documents on WhatsApp\n3️⃣ *Many photos* — fast upload via web link _(recommended for 5+ photos)_\n\nReply with a number.`,

  invalidUploadMode: () => `Please reply with *1*, *2*, or *3*.`,

  awaitingWebUpload: (displayLabel: string, priceEach: string, uploadUrl: string) =>
    `*${displayLabel}* — ${priceEach} each.\n\n📤 Tap this link to upload your photos:\n${uploadUrl}\n\nThe page works on any browser. You can upload as many photos as you want — fast.\n\nWhen you're done, return here and reply *UPLOADED*.\n\n_Link expires in 1 hour. Reply CANCEL to start over._`,

  webUploadStillWaiting: () =>
    `Still waiting for your upload to finish.\n\nWhen you've uploaded your photos via the link, reply *UPLOADED* here.\n\nReply *CANCEL* to start over.`,

  webUploadEmpty: () =>
    `I couldn't find any uploaded photos for this order. Did the upload finish?\n\nIf the upload is still in progress, wait for it to complete then reply *UPLOADED* again.\n\nReply *CANCEL* to start over.`,

  webUploadComplete: (count: number, displayLabel: string, lineTotal: string, cartTotal: string) =>
    `✅ Got it — ${count} photo${count === 1 ? '' : 's'} added at ${displayLabel} for *${lineTotal}*\n\nCart total so far: *${cartTotal}*\n\nWhat next?\n\n1️⃣ Add another item\n2️⃣ Continue to checkout`,

  awaitingBatchUpload: (displayLabel: string, priceEach: string) =>
    `Send your photos for *${displayLabel}* — ${priceEach} each.\n\n📎 Send them as *documents* — you can select all of them at once from your gallery.\n\nI'll confirm every few as they arrive. Reply *DONE* when you're finished.\nReply *CANCEL* to start over.`,

  batchImageAdded: (count: number, widthPx: number, heightPx: number, hasWarning: boolean) =>
    hasWarning
      ? `📷 Photo ${count} received — ${widthPx}×${heightPx}px _(slightly low res — acceptable but not the sharpest)_`
      : `📷 Photo ${count} received ✅`,

  batchProgressUpdate: (count: number) =>
    `📷 ${count} photos received so far ✅\n\nKeep sending, or reply *DONE* when finished.`,

  batchImageRejectedCompressed: () =>
    `⚠️ That image came through compressed and won't print well. Please send it as a *document*:\n📎 Paperclip → *Document* → select the photo.\n\nThe other photos in this batch are still saved. Send the next photo or reply *DONE* when you're finished.`,

  batchImageRejectedTooLow: (widthPx: number, heightPx: number, minW: number, minH: number) =>
    `⚠️ That image is ${widthPx}×${heightPx}px — below the ${minW}×${minH} minimum for a sharp print. Skipped.\n\nThe other photos in this batch are still saved. Send a different photo, or reply *DONE* when you're finished.`,

  batchEmptyOnDone: () =>
    `You haven't sent any photos yet. Upload at least one as a document, or reply *CANCEL* to start over.`,

  batchAdded: (imageCount: number, displayLabel: string, lineTotal: string, cartTotal: string) =>
    `✅ Added: ${imageCount} × ${displayLabel} — *${lineTotal}*\n\nCart total so far: *${cartTotal}*\n\nWhat next?\n\n1️⃣ Add another item\n2️⃣ Continue to checkout`,

  awaitingImage: (displayLabel: string, priceEach: string) =>
    `*${displayLabel}* — ${priceEach} each.\n\nNow send me the photo.\n\n⚠️ *Important:* Send it as a *document/file*, not a regular photo — WhatsApp shrinks regular photos and prints come out blurry.\n\n📎 Tap the paperclip → *Document* → choose your image.`,

  imageWasCompressed: () => `⚠️ That image came through compressed. The print quality may not be good.\n\nPlease re-send as a *document*:\n📎 Paperclip → *Document* → select the photo.\n\nIf you only have it as a regular photo, reply *USE ANYWAY* and I'll print what you sent (quality may be lower).`,

  imageTooLow: (widthPx: number, heightPx: number, minW: number, minH: number) =>
    `⚠️ This image is ${widthPx}×${heightPx} pixels — below the minimum ${minW}×${minH} for a sharp print.\n\n1️⃣ Send a different photo\n2️⃣ Print anyway _(may look soft)_`,

  imageWarnLow: (widthPx: number, heightPx: number, recW: number, recH: number) =>
    `⚠️ Image is ${widthPx}×${heightPx} pixels. For best results I recommend ${recW}×${recH}.\n\n1️⃣ Send a different photo\n2️⃣ Continue anyway`,

  imageOk: (widthPx: number, heightPx: number) =>
    `✅ Got it — ${widthPx}×${heightPx}px, looking good.\n\nHow many copies?`,

  imageOkNoCheck: () => `✅ Got it.\n\nHow many copies?`,

  // ===== Quantity =====

  invalidQuantity: () => `Please reply with a whole number, e.g. *1*, *5*, or *20*.`,

  // ===== Cart =====

  itemAdded: (item: CartItem, cartTotal: string) =>
    `✅ Added: ${item.quantity} × ${item.displayLabel} — *$${item.lineTotalUsd.toFixed(2)}*\n\nCart total so far: *${cartTotal}*\n\nWhat next?\n\n1️⃣ Add another item\n2️⃣ Continue to checkout`,

  addMoreOrCheckout: () => `1️⃣ Add another item\n2️⃣ Continue to checkout`,

  // ===== Name collection (first order only) =====

  askName: () => `One quick thing — what's your name? _(just need it once)_`,

  invalidName: () => `Please reply with your name.`,

  // ===== Fulfillment =====

  chooseFulfillment: (name: string) =>
    `Thanks *${name}*! How would you like to receive your prints?\n\n1️⃣ *Collect* — ${COLLECTION_ADDRESS} _(free)_\n2️⃣ *Deliver* in Harare — $3.00\n3️⃣ *Deliver* outside Harare — _(quote first)_`,

  askDeliveryAddress: () => `Please send your delivery address in Harare.`,

  outsideHarare: () => `For deliveries outside Harare, please send us your address and we'll quote you a delivery fee before confirming the order.`,

  invalidFulfillmentChoice: () => `Please reply with *1*, *2*, or *3*.`,

  // ===== Order confirmation =====

  confirmOrder: (summary: string) =>
    `${summary}\n\nReply *PAY* to confirm and get a payment link, or *CANCEL* to start over.`,

  orderCancelled: () => `Order cancelled. Type anything to start a new order.`,

  // ===== Payment =====

  paymentLinkSent: (orderNumber: string, paymentUrl: string, totalUsd: string) =>
    `Here's your payment link:\n🔗 ${paymentUrl}\n\nPays via card or EcoCash. You'll get a confirmation here once payment goes through.\n\n*Order #:* ${orderNumber}\n*Amount:* $${totalUsd}\n\n_Link expires in 60 minutes._`,

  paymentTimeout: (orderNumber: string) =>
    `Your payment link for order *${orderNumber}* has expired.\n\nReply *RETRY* to get a new link, or *CANCEL* to start over.`,

  paymentConfirmed: (orderNumber: string) =>
    `✅ *Payment received!*\n\nOrder *${orderNumber}* is now in the queue.\n\nI'll message you when your prints are ready. Photo prints are usually done within *1 hour* during business hours.`,

  paymentConfirmedPoster: (orderNumber: string) =>
    `✅ *Payment received!*\n\nOrder *${orderNumber}* — your poster will go through a quick quality check before printing _(within 2 hours, business hours)_. I'll message you once it's confirmed.`,

  // ===== Ready for collection / delivery =====

  orderReady: (orderNumber: string) =>
    `🎉 *Your prints are ready!*\n\nOrder *${orderNumber}*\n📍 ${COLLECTION_ADDRESS}\n🕒 ${BUSINESS_HOURS}\n\nBring your phone — show this message when you collect.`,

  orderReadyDelivery: (orderNumber: string) =>
    `🎉 *Your prints are on their way!*\n\nOrder *${orderNumber}* has been handed to our courier. Expect delivery within 2–4 hours.`,

  // ===== Order status =====

  orderStatus: (orderNumber: string, status: string) =>
    `Order *${orderNumber}*: ${status}`,

  noRecentOrders: () => `I don't have any recent orders for your number. Type anything to place a new order.`,

  // ===== Help / fallback =====

  help: () => `Here's what I can help with:\n\n📷 *Print photos* — type *photos*\n🖼️ *Print posters* — type *posters*\n📦 *Check your order* — type *status*\n👤 *Talk to a person* — type *HELP*\n\nOr just reply with *1*, *2*, or *3* from the menu.`,

  humanHandoff: () => `I'll connect you with a real person right away.\n\nPlease WhatsApp us directly: ${process.env.BUSINESS_PHONE ?? '[business number]'}\n\nOr reply to continue with the bot.`,

  somethingWentWrong: () => `Something went wrong on my end. Please try again, or type *HELP* to speak to a person.`,
};
