const Airtable = require('airtable');
const Stripe = require('stripe');
const express = require('express');
const cors = require("cors");
const axios = require('axios');
const cron = require('node-cron');
const bodyParser = require('body-parser');
const nodemailer = require("nodemailer");

require('dotenv').config();

const app = express();

Airtable.configure({
  apiKey: process.env.AIRTABLE_API_KEY,
});

const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASSWORD,
  },
});


const base2 = Airtable.base(process.env.AIRTABLE_BASE_ID);

const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;


app.use('/webhook', express.raw({ type: 'application/json' }));

// stripe Webhook handler
app.post('/webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const rawBody = req.body;

  let event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, sig, endpointSecret);
  } catch (err) {
    console.error('⚠️ Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;

    const clientReferenceId = session.client_reference_id;
    const paymentIntentId = session.payment_intent;
    const amountTotal = session.amount_total;
    const checkid = session.id;

    console.log(`Processing checkout session for PaymentIntent: ${paymentIntentId}`);

    if (!clientReferenceId || !paymentIntentId) {
      console.warn('Missing client_reference_id or payment_intent in session');
      return res.status(400).send('Invalid session data');
    }

    try {
      const records = await base2('Payment Records')
        .select({
          sort: [{ field: 'Created', direction: 'desc' }],
          maxRecords: 2,
        })
        .firstPage();

      const matchingRecord = records.find(
        (record) => String(record.id) === String(clientReferenceId)
      );

      if (matchingRecord) {
        // Update the matching payment record
        await base2('Payment Records').update(matchingRecord.id, {
          'Payment ID': paymentIntentId,
          'Amount Total': formatCurrency(amountTotal),
          'Payment Status': 'Paid',
          'Payment record id': checkid,
        });
        console.log(`Payment record (${clientReferenceId}) updated successfully.`);
      } else {
        console.warn(`No matching Airtable record found for clientReferenceId: ${clientReferenceId}`);
      }

      // Proceed to update class and field data
      const lastRecord = matchingRecord;
      const seatCount = parseInt(lastRecord.fields['Number of seat Purchased'], 10);
      // const classFieldValue = lastRecord.fields['Airtable id'];
      const classFieldValue = lastRecord.fields["Field ID (from Biaw Classes)"]?.[0] || "No details provided"; //new feild
      const multipleClassRegistrationIds = lastRecord.fields['Multiple Class Registration'] || [];
      const userEmail = lastRecord.fields['Email'];
      const userName = lastRecord.fields['Name'];
      const purchasedClassUrl = lastRecord.fields['Purchased Class url'];

      const classRecords = await base2('Biaw Classes')
        .select({
          filterByFormula: `{Field ID} = '${classFieldValue}'`,
          maxRecords: 1,
        })
        .firstPage();

      if (classRecords.length === 0) {
        console.warn(`Class record not found for ID: ${classFieldValue}`);
        return;
      }

      const classRecord = classRecords[0];
      const currentSeatsRemaining = parseInt(classRecord.fields['Number of seats remaining'], 10);
      const totalPurchasedSeats = parseInt(classRecord.fields['Total Number of Purchased Seats'] || '0', 10);
      const className = classRecord.fields['Name'];
      const instructorName = classRecord.fields['Instructor Name (from Instructors)'];
      const paltform = classRecord.fields["Local Association Name (from Location 2)"]?.[0] || "No details provided";

      const discription = classRecord.fields['Description']

      if (currentSeatsRemaining < seatCount) {
        console.error('Not enough seats available for this class.');
        return;
      }

      // Update class record with new seat counts
      await base2('Biaw Classes').update(classRecord.id, {
        'Number of seats remaining': String(currentSeatsRemaining - seatCount),
        'Total Number of Purchased Seats': String(totalPurchasedSeats + seatCount),
      });

      console.log(
        `Class record updated. Remaining seats: ${currentSeatsRemaining - seatCount
        }, Total purchased seats: ${totalPurchasedSeats + seatCount}`
      );

      // Update multiple class registration records
      for (const multipleClassId of multipleClassRegistrationIds) {
        try {
          console.log(`Updating record ID ${multipleClassId} in Multiple Class Registration table.`);
          await base2(AIRTABLE_TABLE_NAME2).update(multipleClassId, {
            'Payment Status': 'Paid',
          });
          console.log(`Payment Status updated to "Paid" for record ID ${multipleClassId}.`);
        } catch (error) {
          console.error(`Failed to update record ID ${multipleClassId}:`, error.message);
        }
      }

      // Send confirmation email
      const transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: {
          user: process.env.EMAIL_USER,
          pass: process.env.EMAIL_PASSWORD,
        },
      });

      const mailOptions = {
        from: `"BIAW Support" <${process.env.EMAIL_USER}>`,
        to: userEmail,
        subject: `Class Registration Confirmation for ${className}`,
        html: `
        <p>Hi ${userName},</p>
        <h4>Thank you for registering!</h4>
        <p>Your registration for the class <strong>${className}</strong> (instructor: ${instructorName}) has been confirmed. Below are your details:</p>
        <p>description : ${discription}</p>
        <ul>
          <li>Class URL: <a href="${purchasedClassUrl}">${purchasedClassUrl}</a></li>
          <li>Number of Seats Purchased: ${seatCount}</li>
          <li>Total Amount Paid: ${formatCurrency(amountTotal)}</li>
          <li>Location : ${paltform}</li>
        </ul>
        <p>We look forward to seeing you in class!</p>
        <p>Best regards,<br>BIAW Support</p>
      `,
      };

      transporter.sendMail(mailOptions, (error, info) => {
        if (error) {
          console.error('Failed to send email:', error.message);
        } else {
          console.log(`Email sent to ${userEmail}: ${info.response}`);
        }
      });
    } catch (error) {
      console.error('Error processing the webhook event:', error);
    }
  } else {
    console.log(`Unhandled event type: ${event.type}`);
  }

  res.status(200).send('Received');
});



// Helper function to format currency
function formatCurrency(amount) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(amount / 100);
}



app.use(express.json());

const allowedOrigins = [
  "https://biaw-stage-api.webflow.io",
];
app.use(
  cors({
    origin: allowedOrigins,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: true,
  })
);

app.get("/", (req, res) => {
  res.send("Server is running and ready to accept requests.");
});

const airtable = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY });
const stripe = new Stripe(process.env.STRIPE_API_KEY);

const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
const AIRTABLE_TABLE_NAME = process.env.AIRTABLE_TABLE_NAME;
const WEBFLOW_API_KEY = process.env.WEBFLOW_API_KEY;
const WEBFLOW_COLLECTION_ID = process.env.WEBFLOW_COLLECTION_ID;
const AIRTABLE_TABLE_NAME2 = process.env.AIRTABLE_TABLE_NAME2
const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY
const AIRTABLE_TABLE_NAME3 = process.env.AIRTABLE_TABLE_NAME3
const WEBFLOW_COLLECTION_ID2 = process.env.WEBFLOW_COLLECTION_ID2
const AIRTABLE_TABLE_NAME4 = process.env.AIRTABLE_TABLE_NAME4
const WEBFLOW_COLLECTION_ID3 = process.env.WEBFLOW_COLLECTION_ID3
const AIRTABLE_TABLE_NAME5 = process.env.AIRTABLE_TABLE_NAME5

function logError(context, error) {
  console.error(`[ERROR] ${context}:`, error.message || error);
}

// Helper function to parse price values
const parsePrice = (price) => {
  try {
    if (typeof price === "number") {
      return price;
    }

    if (typeof price === "string") {
      const cleanedPrice = price.replace(/[$,]/g, '');
      const parsedPrice = parseFloat(cleanedPrice);
      if (isNaN(parsedPrice)) {
        throw new Error(`Invalid price value: ${price}`);
      }
      return parsedPrice;
    }

    throw new Error("Price is missing or invalid.");
  } catch (error) {
    throw new Error(`Price parsing failed: ${error.message}`);
  }
};

function generateRandomCode(length) {
  const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += characters.charAt(Math.floor(Math.random() * characters.length));
  }
  return result;
}

// Fetch new records from Airtable
async function fetchNewClasses() {
  try {
    // Fetch records where {Publish / Unpublish} = 'Publish'
    const records = await airtable
      .base(AIRTABLE_BASE_ID)(AIRTABLE_TABLE_NAME)
      .select({
        filterByFormula: "{Publish / Unpublish} = 'Publish'"
      })
      .all();

    // Filter records to include only those where {Item Id} has no value
    const filteredRecords = records.filter(record => !record.fields["Item Id"]);

    // Skip the function if no records meet the criteria
    if (filteredRecords.length === 0) {
      console.log("No new records to process.");
      return [];
    }

    console.log("Fetched and filtered records from Airtable:", filteredRecords.map((rec) => rec.fields));
    return filteredRecords.map(record => ({ id: record.id, ...record.fields }));
  } catch (error) {
    logError("Fetching Airtable Records", error);
    return [];
  }
}


// Create Stripe products and coupon code
async function createStripeProductsAndCoupon(classDetails) {
  try {
    if (!classDetails.Name || !classDetails["Price - Member"] || !classDetails["Price - Non Member"]) {
      throw new Error("Class details are incomplete");
    }

    const memberPriceAmount = parsePrice(classDetails["Price - Member"]);
    const nonMemberPriceAmount = parsePrice(classDetails["Price - Non Member"]);
    const discountPercentage = parseInt(classDetails["% Discounts"] || "0", 10);
    const maxDiscountedSeats = parseInt(classDetails["Maximum discounted seats"] || "0", 10);

    // Create only two Stripe products: One for Member and one for Non-Member
    const memberProduct = await stripe.products.create({
      name: `${classDetails.Name} - Member`,
      description: classDetails.Description || "No description provided",
    });

    const nonMemberProduct = await stripe.products.create({
      name: `${classDetails.Name} - Non-Member`,
      description: classDetails.Description || "No description provided",
    });

    const memberPrice = await stripe.prices.create({
      unit_amount: Math.round(memberPriceAmount * 100),
      currency: 'usd',
      product: memberProduct.id,
    });

    const nonMemberPrice = await stripe.prices.create({
      unit_amount: Math.round(nonMemberPriceAmount * 100),
      currency: 'usd',
      product: nonMemberProduct.id,
    });

    let discountCoupon = null;
    let promotionCode = null;

    if (!isNaN(discountPercentage) && discountPercentage > 0) {
      // Build the coupon data conditionally
      const couponData = {
        percent_off: discountPercentage,
        duration: 'once',
        name: `${discountPercentage}% Discount`,
        applies_to: {
          products: [memberProduct.id, nonMemberProduct.id], // Apply to both products
        },
      };

      // Include max_redemptions only if maxDiscountedSeats > 0
      if (maxDiscountedSeats > 0) {
        couponData.max_redemptions = maxDiscountedSeats;
      }

      discountCoupon = await stripe.coupons.create(couponData);
      console.log("Coupon created successfully:", discountCoupon);

      // Create a single promotion code
      const generatedCode = generateRandomCode(8); // Example: kGS4ll45
      promotionCode = await stripe.promotionCodes.create({
        coupon: discountCoupon.id,
        code: generatedCode,
      });

      console.log("Promotion code created successfully:", promotionCode);
    }

    // Enable promo code during payment link creation
    const memberPaymentLink = await stripe.paymentLinks.create({
      line_items: [{ price: memberPrice.id, quantity: 1 }],
      allow_promotion_codes: true, // Enable promotion codes
    });

    const nonMemberPaymentLink = await stripe.paymentLinks.create({
      line_items: [{ price: nonMemberPrice.id, quantity: 1 }],
      allow_promotion_codes: true, // Enable promotion codes
    });

    return {
      memberProduct,
      memberPrice,
      memberPaymentLink,
      nonMemberProduct,
      nonMemberPrice,
      nonMemberPaymentLink,
      discountCoupon,
      promotionCode,
      generatedCode2: promotionCode?.code,
    };
  } catch (error) {
    console.error("Error processing class:", error.stack || error.message || error);
    throw error;
  }
}

// Clean the slug by removing any non-alphabetic characters and keeping only letters and spaces
function generateSlug(classDetails, dropdownValue) {
  const cleanedName = classDetails.Name
    .replace(/[^a-zA-Z\s]/g, '')
    .toLowerCase()
    .replace(/\s+/g, '-');

  const cleanedDropdownValue = dropdownValue.toLowerCase().replace(/\s+/g, '-');

  return `${cleanedName}-${cleanedDropdownValue}`;
}

// Function to add CMS class to Webflow
async function addToWebflowCMS(classDetails, stripeInfo) {
  try {
    const instructorName = Array.isArray(classDetails["Instructor Name (from Instructors)"])
      ? classDetails["Instructor Name (from Instructors)"].join(", ")
      : classDetails["Instructor Name (from Instructors)"];

    const instructorPicField = classDetails["Instructor Pic (from Instructors)"];
    const instructorPicUrl = instructorPicField && instructorPicField.length > 0 ? instructorPicField[0].url : "";

    const imagesField = classDetails["Images"];
    const imageUrls = imagesField && imagesField.length > 0 ? imagesField.map((image) => image.url) : [];

    const bannerimagesField = classDetails["Banner image"];
    const bannerimageUrls = bannerimagesField && bannerimagesField.length > 0 ? bannerimagesField.map((image) => image.url) : [];

    const instructorDetails = classDetails["Instructor Details (from Instructors)"]?.[0] || "No details provided";
    const instructorCompany = classDetails["Instructor Company (from Instructors)"]?.[0] || "No company provided";

    const city = classDetails["City (from Location 2)"]?.[0] || "No details provided";
    const state = classDetails["State (from Location 2)"]?.[0] || "No details provided";
    const location2 = classDetails["Local Association Name (from Location 2)"]?.[0] || "No details provided";
    const zipcode = classDetails["Zip (from Location 2)"]?.[0] || "No details provided";


    const relatedClassIdsForMember = classDetails["Item Id (from Related Classes )"] || [];
    const relatedClassIdsForNonMember = classDetails["Item Id 2 (from Related Classes )"] || [];

    // Validate the related class IDs against Webflow data
    const validatedRelatedClassIdsForMember = await validateWebflowItemIds(relatedClassIdsForMember);
    const validatedRelatedClassIdsForNonMember = await validateWebflowItemIds(relatedClassIdsForNonMember);

    const itemIds = []; // To store Webflow item IDs

    for (const dropdownValue of ["Member", "Non-Member"]) {
      let memberValue = "No";
      let nonMemberValue = "No";
      let paymentLink = "";
      let relatedClassIds = [];
      // let category = [];

      if (dropdownValue === "Member") {
        memberValue = "Yes";
        nonMemberValue = "No";
        paymentLink = stripeInfo.memberPaymentLink.url;
        relatedClassIds = validatedRelatedClassIdsForMember;
        // category = validatecategoryforMember;

      } else if (dropdownValue === "Non-Member") {
        memberValue = "No";
        nonMemberValue = "Yes";
        paymentLink = stripeInfo.nonMemberPaymentLink.url;
        relatedClassIds = validatedRelatedClassIdsForNonMember;
        // category = validatecategoryforNonmember ;

      }
      const slug = generateSlug(classDetails, dropdownValue);

      // Prepare API request to Webflow
      const response = await axios.post(
        `https://api.webflow.com/v2/collections/${WEBFLOW_COLLECTION_ID}/items/live`,
        {
          fieldData: {
            name: classDetails.Name,
            slug: slug,
            description: classDetails.Description || "No description available",
            "price-member": String(classDetails["Price - Member"]),
            "price-non-member": String(classDetails["Price - Non Member"]),
            "member-price-id": dropdownValue === "Member" ? String(stripeInfo.memberPrice.id) : "",
            "non-member-price-id": dropdownValue === "Non-Member" ? String(stripeInfo.nonMemberPrice.id) : "",
            "field-id": String(classDetails["Field ID"]),
            date: classDetails.Date,
            "end-date": classDetails["End date"],
            location: location2,
            "payment-link": paymentLink,
            "start-time": classDetails["Start Time"],
            "end-time": classDetails["End Time"],
            "class-type": classDetails["Product Type"],
            "instructor-name": instructorName,
            "instructor-pic": instructorPicUrl,
            "image-2": imageUrls,
            "main-images": imageUrls,
            "instructor-details": instructorDetails,
            "instructor-company": instructorCompany,
            "price-roii-participants": classDetails["Price - ROII Participants (Select)"],
            "created-date": classDetails.Created,
            "number-of-seats": String(classDetails["Number of seats"]),
            "airtablerecordid": classDetails.id,
            "member-non-member": dropdownValue,
            "member": memberValue,
            "city": city,
            "state": state,
            "zip": zipcode,
            "sort-orders": classDetails['Sort order'],
            "non-member": nonMemberValue,
            "number-of-remaining-seats": String(classDetails["Number of seats"]),
            "related-classes": relatedClassIds,
            "banner-image":bannerimageUrls
          },
        },
        {
          headers: {
            Authorization: `Bearer ${WEBFLOW_API_KEY}`,
            "Content-Type": "application/json",
          },
        }
      );

      itemIds.push(response.data.id);

      console.log(`Successfully added ${dropdownValue} entry for class: ${classDetails.Name}`);
    }
    return itemIds; // Return both item IDs
  } catch (error) {
    if (error.response) {
      console.error("Webflow API Error:", error.response.data);
    } else {
      console.error("Unknown Error:", error.message);
    }
    throw error;
  }
}

// Function to validate Webflow item IDs
async function validateWebflowItemIds(itemIds) {
  try {
    const response = await axios.get(`https://api.webflow.com/v2/collections/${WEBFLOW_COLLECTION_ID}/items`, {
      headers: {
        Authorization: `Bearer ${WEBFLOW_API_KEY}`,
        "Content-Type": "application/json",
      },
    });

    const webflowItems = response.data.items; // Webflow items data
    const webflowItemIds = new Set(webflowItems.map((item) => item.id)); // Create a set of Webflow item IDs

    // Return only IDs that exist in Webflow
    return itemIds.filter((id) => webflowItemIds.has(id));
  } catch (error) {
    console.error("Error validating Webflow item IDs:", error.message);
    throw error;
  }
}


// // runPeriodicallyw(30 * 1000);
const airtableBaseURLs = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${AIRTABLE_TABLE_NAME}`;
const airtableHeaderss = {
  Authorization: `Bearer ${AIRTABLE_API_KEY}`,
};

const webflowBaseURLs = `https://api.webflow.com/v2/collections/${WEBFLOW_COLLECTION_ID}/items`;
const webflowHeaderss = {
  Authorization: `Bearer ${WEBFLOW_API_KEY}`,
  "Content-Type": "application/json",
};
async function syncRemainingSeats() {
  try {
    // Fetch Airtable data
    const airtableResponse = await axios.get(airtableBaseURLs, { headers: airtableHeaderss });
    const airtableRecords = airtableResponse.data.records;

    console.log(`Fetched ${airtableRecords.length} records from Airtable.`);

    // Fetch Webflow data
    let webflowRecords = [];
    try {
      const webflowResponse = await axios.get(webflowBaseURLs, { headers: webflowHeaderss });
      webflowRecords = webflowResponse.data.items || [];
      console.log(`Fetched ${webflowRecords.length} records from Webflow.`);
    } catch (webflowError) {
      console.error("Error fetching records from Webflow:", webflowError.response?.data || webflowError.message);
      return;
    }

    // Create a map of Webflow records by Airtable ID
    const webflowRecordMap = new Map();
    webflowRecords.forEach((record) => {
      const airtableId = record.fieldData["airtablerecordid"];
      if (airtableId) {
        if (!webflowRecordMap.has(airtableId)) {
          webflowRecordMap.set(airtableId, []);
        }
        webflowRecordMap.get(airtableId).push(record);
      }
    });

    // Always sync `number-of-remaining-seats`
    for (const airtableRecord of airtableRecords) {
      const airtableId = airtableRecord.id;
      const airtableSeatsRemaining = airtableRecord.fields["Number of seats remaining"];
      const webflowRecordsToUpdate = webflowRecordMap.get(airtableId);

      if (webflowRecordsToUpdate) {
        for (const webflowRecord of webflowRecordsToUpdate) {
          const webflowSeatsRemaining = webflowRecord.fieldData["number-of-remaining-seats"];
          if (String(webflowSeatsRemaining) !== String(airtableSeatsRemaining)) {
            const updateURL = `${webflowBaseURLs}/${webflowRecord.id}/live`;
            const updateData = {
              fieldData: {
                "number-of-remaining-seats": String(airtableSeatsRemaining),
              },
            };
            try {
              await axios.patch(updateURL, updateData, { headers: webflowHeaderss });
              console.log(`Updated number-of-remaining-seats for Webflow record ID ${webflowRecord.id}.`);
            } catch (error) {
              console.error(
                `Error updating number-of-remaining-seats for Webflow record ID ${webflowRecord.id}:`,
                error.response?.data || error.message
              );
            }
          }
        }
      }
    }

  } catch (error) {
    console.error("Error syncing data:", error.response?.data || error.message);
  }
}

// Run the sync function
syncRemainingSeats();

async function runPeriodicallyw(intervalMs) {
  console.log("Starting periodic sync...");
  setInterval(async () => {
    console.log(`Running sync at ${new Date().toISOString()}`);
    await syncRemainingSeats();
  }, intervalMs);
}

runPeriodicallyw(30 * 1000);


// Update Airtable record with Stripe Product ID
async function updateAirtableRecord(recordId, stripeInfo, generatedCode2, itemIds ,classDetails) {
  try {
    // Validate recordId
    if (!recordId) {
      throw new Error("Invalid recordId: recordId is undefined or empty.");
    }

    const numberOfSeats = String(classDetails["Number of seats"] ?? "0");

    
    // Perform the update
    await airtable.base(AIRTABLE_BASE_ID)(AIRTABLE_TABLE_NAME).update(recordId, {
      "Item Id": itemIds[0] ?? "Unknown Member Price ID", // Member item ID
      "Item Id 2": itemIds[1] ?? "Unknown Member Price ID", // Non-Member item ID
      "Member Price ID": String(stripeInfo?.memberPrice?.id ?? "Unknown Member Price ID"),
      "Non-Member Price ID": String(stripeInfo?.nonMemberPrice?.id ?? "Unknown Non-Member Price ID"),
      "Coupon Code": generatedCode2,
      "Publish / Unpublish": "Published",
      "Number of seats remaining": numberOfSeats
    });

    console.log("Airtable record updated successfully!");
  } catch (error) {
    console.error("Error updating Airtable Record:", {
      recordId,
      stripeInfo,
      generatedCode2,
      error: error.message,
      itemIds,
      classDetails
    });
    throw error;
  }
}


let isProcessing = false; // Flag to prevent overlapping executions

// Main function to process new classes
async function processNewClasses() {
  const newClasses = await fetchNewClasses();

  // Remove duplicate classes (if applicable)
  const uniqueClasses = Array.from(new Set(newClasses.map(JSON.stringify))).map(JSON.parse);
  console.log("Unique Classes:", uniqueClasses);

  for (const classDetails of uniqueClasses) {
    try {
      console.log(`Processing class: ${classDetails.Name}`);

      // Create Stripe product, prices, and coupon
      const stripeInfo = await createStripeProductsAndCoupon(classDetails);

      // Add class to Webflow CMS and get item IDs
      const itemIds = await addToWebflowCMS(classDetails, stripeInfo);
      console.log("Webflow Item IDs:", itemIds); // Log the item IDs

      // Ensure two IDs are returned (one for Member, one for Non-Member)
      if (!itemIds || itemIds.length !== 2) {
        throw new Error(`Invalid Webflow item IDs returned: ${itemIds}`);
      }

      // Update Airtable with Stripe Product ID and Webflow item IDs
      await updateAirtableRecord(classDetails.id, stripeInfo, stripeInfo.generatedCode2, itemIds ,classDetails);

      console.log(`Successfully processed class: ${classDetails.Name}`);
    } catch (error) {
      logError(`Processing class: ${classDetails.Name}`, error);
    }
  }
}




app.post("/api/delete", async (req, res) => {
  try {
    const { id, fields } = req.body; // Airtable payload
    const airtableId = id;

    if (!fields || !fields["Publish / Unpublish"]) {
      return res.status(400).send("Missing required fields in the payload.");
    }

    // Extract publish status
    const publishStatus = fields["Publish / Unpublish"]?.name; // Access 'name' from the object

    console.log(`Webhook received for Airtable ID: ${airtableId}, Status: ${publishStatus}`);

    // Fetch corresponding Webflow records
    const webflowResponse = await axios.get(webflowBaseURLs, { headers: webflowHeaderss });
    const webflowRecords = webflowResponse.data.items || [];
    const webflowRecordsToUpdate = webflowRecords.filter(
      (record) => record.fieldData["airtablerecordid"] === airtableId
    );

    // Handle "Delete"
    if (publishStatus === "Delete") {
      for (const webflowRecord of webflowRecordsToUpdate) {
        const updateURL = `${webflowBaseURLs}/${webflowRecord.id}/live`;
        const updateData = {
          fieldData: { "class-delete-2": "Delete" },
        };

        try {
          await axios.patch(updateURL, updateData, { headers: webflowHeaderss });
          console.log(`Set class-delete-2 to "Delete" for Webflow record ID ${webflowRecord.id}`);
        } catch (error) {
          console.error(`Error updating Webflow record ID ${webflowRecord.id}:`, error.message);
        }
      }

      // Delete the Airtable record
      try {
        await axios.delete(`${airtableBaseURLs}/${airtableId}`, { headers: airtableHeaderss });
        console.log(`Deleted Airtable record ${airtableId}.`);
      } catch (error) {
        console.error(`Error deleting Airtable record ${airtableId}:`, error.message);
      }
    }

    // Add logic for "Update" or other statuses here...

    res.status(200).send("Webhook processed successfully.");
  } catch (error) {
    console.error("Error processing webhook:", error.message);
    res.status(500).send("Internal Server Error");
  }
});


// Define headers and base URLs
const airtableBaseURL2 = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${AIRTABLE_TABLE_NAME}`;
const airtableHeaders2 = {
  Authorization: `Bearer ${AIRTABLE_API_KEY}`,
};


const webflowBaseURL2 = `https://api.webflow.com/v2/collections/${WEBFLOW_COLLECTION_ID}/items`;
const webflowHeaders2 = {
  Authorization: `Bearer ${WEBFLOW_API_KEY}`,
  "Content-Type": "application/json",
};
//update class webhook
app.post("/api/endpoint", async (req, res) => {
  const { id, fields } = req.body;

  try {
    console.log("Received data:", { id, fields });

    // Fetch matching Webflow records
    const webflowResponse = await axios.get(webflowBaseURL2, { headers: webflowHeaders2 });
    const webflowRecords = webflowResponse.data.items || [];
    const matchingWebflowRecords = webflowRecords.filter(
      (record) => record.fieldData?.airtablerecordid === id
    );

    if (matchingWebflowRecords.length === 0) {
      console.warn(`No matching Webflow records found for Airtable ID: ${id}`);
      return res.status(404).json({ error: "No matching Webflow records found" });
    }

    // Iterate over matching Webflow records
    for (const webflowRecord of matchingWebflowRecords) {
      const updates = {};

      const priceROIIName = fields["Price - ROII Participants (Select)"]?.name;
      const productTypeName = fields["Product Type"]?.name;


      // Extract images from Airtable
      const airtableImages = fields["Images"]?.map((imageObj) => imageObj.url) || [];
      const webflowImages = webflowRecord.fieldData["main-images"] || [];
      const imagesAreDifferent =
        airtableImages.length !== webflowImages.length ||
        airtableImages.some((image, index) => image !== webflowImages[index]);

      if (imagesAreDifferent) {
        updates["main-images"] = airtableImages;
      }
//
      const airtableBannerImages = fields["Banner image"]?.map((imageObj) => imageObj.url) || [];
      const webflowBannerImages = webflowRecord.fieldData["banner-image"] || [];
      const imagesAreDifferent1 =
      airtableBannerImages.length !== webflowBannerImages.length ||
      airtableBannerImages.some((image, index) => image !== webflowBannerImages[index]);

      if (imagesAreDifferent1) {
        updates["banner-image"] = airtableBannerImages;
      }
      //
      const publishUnpublishValue = fields["Publish / Unpublish"]?.name;
      
      if (webflowRecord.fieldData["class-delete-2"] !== publishUnpublishValue) {
      updates["class-delete-2"] = publishUnpublishValue;
      }
      //
      const airtableInstructorPics = fields["Instructor Pic (from Instructors)"]?.map(
        (picObj) => picObj.url
      ) || [];
      const webflowInstructorPics = webflowRecord.fieldData["instructor-pic"] || [];
      const instructorPicsAreDifferent =
        airtableInstructorPics.length !== webflowInstructorPics.length ||
        airtableInstructorPics.some((pic, index) => pic !== webflowInstructorPics[index]);

      if (instructorPicsAreDifferent) {
        updates["instructor-pic"] = airtableInstructorPics;
      }

      //
      if (webflowRecord.fieldData["number-of-seats"] !== String(fields["Number of seats"])) {
        updates["number-of-seats"] = String(fields["Number of seats"]);
      }
      if (
        webflowRecord.fieldData["number-of-remaining-seats"] !==
        String(fields["Number of seats remaining"])
      ) {
        updates["number-of-remaining-seats"] = String(fields["Number of seats remaining"]);
      }
      if (webflowRecord.fieldData.name !== fields.Name) {
        updates.name = fields.Name;
      }
      if (webflowRecord.fieldData["price-roii-participants"] !== priceROIIName) {
        updates["price-roii-participants"] = priceROIIName;
      }
      if (webflowRecord.fieldData["start-time"] !== fields["Start Time"]) {
        updates["start-time"] = fields["Start Time"];
      }
      if (webflowRecord.fieldData["end-time"] !== fields["End Time"]) {
        updates["end-time"] = fields["End Time"];
      }
      if (webflowRecord.fieldData["sort-orders"] !== fields["Sort order"]) {
        updates["sort-orders"] = fields["Sort order"];
      }
      if (webflowRecord.fieldData["date"] !== fields["Date"]) {
        updates["date"] = fields["Date"];
      }
      if (webflowRecord.fieldData["end-date"] !== fields["End date"]) {
        updates["end-date"] = fields["End date"];
      }
      if (webflowRecord.fieldData["zip"] !== fields["Zip (from Location 2)"].join(", ")) {
        updates["zip"] = fields["Zip (from Location 2)"].join(", ");
      }
      if (webflowRecord.fieldData["location"] !== fields["Local Association Name (from Location 2)"].join(", ")) {
        updates["location"] = fields["Local Association Name (from Location 2)"].join(", ");
      }
      if (webflowRecord.fieldData["description"] !== fields["Description"]) {
        updates["description"] = fields["Description"];
      }

      if (webflowRecord.fieldData["class-type"] !== productTypeName) {
        updates["class-type"] = productTypeName;
      }

      // Extract city details
      const city1 = fields["City (from Location 2)"]?.join(", ");;

      // Compare and update city field in Webflow
      if (webflowRecord.fieldData["city"] !== city1) {
      updates["city"] = city1;
      }


      // Handle related-classes field
      const id1 = fields["Item Id (from Related Classes )"] || null;
      const id2 = fields["Item Id 2 (from Related Classes )"] || null;
      let newRelatedClassId = null;

      // Check "member" field for determining the related class ID
      const isMember = webflowRecord.fieldData["member"];
      if (isMember === "Yes") {
        newRelatedClassId = id1;
      } else if (isMember === "No") {
        newRelatedClassId = id2;
      }

      if (newRelatedClassId) {
        updates["related-classes"] = newRelatedClassId;
      } else {
        console.warn(`Skipping related-classes update for Webflow record ID ${webflowRecord.id}`);
      }

      // Instructor details
      const instructname = fields["Instructor Name (from Instructors)"]?.join(", ");
      const instructcompany = fields["Instructor Company (from Instructors)"]?.join(", ");
      const instructdetails = fields["Instructor Details (from Instructors)"]?.join(", ");
      
      if (webflowRecord.fieldData["instructor-name"] !== instructname) {
        updates["instructor-name"] = instructname;
      }
      if (webflowRecord.fieldData["instructor-company"] !== instructcompany) {
        updates["instructor-company"] = instructcompany;
      }
      if (webflowRecord.fieldData["instructor-details"] !== instructdetails) {
        updates["instructor-details"] = instructdetails;
      }

      // If there are updates, send them to Webflow
      if (Object.keys(updates).length > 0) {
        const updateURL = `${webflowBaseURL2}/${webflowRecord.id}/live`;
        try {
          await axios.patch(updateURL, { fieldData: updates }, { headers: webflowHeaders2 });
          console.log(`Updated Webflow record ID: ${webflowRecord.id}`);
        } catch (updateError) {
          console.error(
            `Error updating Webflow record ID ${webflowRecord.id}:`,
            updateError.response?.data || updateError.message
          );
        }
      } else {
        console.log(`No updates needed for Webflow record ID: ${webflowRecord.id}`);
      }
    }

    // Mark Airtable record as updated
    await axios.patch(
      `${airtableBaseURL2}/${id}`,
      { fields: { "Publish / Unpublish": "Updated" } },
      { headers: airtableHeaders2 }
    );
    console.log(`Marked Airtable record ${id} as "Updated".`);

    res.status(200).json({ message: "Sync completed successfully" });
  } catch (error) {
    console.error("Error syncing data:", error.response?.data || error.message);
    res.status(500).json({ error: "Sync failed" });
  }
});



// Airtable setup
const base = new Airtable({ apiKey: AIRTABLE_API_KEY }).base(AIRTABLE_BASE_ID);

app.post('/waitlist', async (req, res) => {
  const { loginDetails, classId, loginMember, className, instructor, classur } = req.body;

  // Validation
  if (!loginDetails || !classId || !loginMember || !className || !instructor) {
    return res.status(400).json({ message: 'All fields are required.' });
  }

  try {
    // Step 1: Fetch the class record from the Biaw Classes table
    const classRecords = await base(AIRTABLE_TABLE_NAME)
      .select({
        filterByFormula: `{Field ID} = '${classId}'`, // Filter by Class ID
        maxRecords: 1, // Only fetch the first matching record
      })
      .firstPage();

    if (classRecords.length === 0) {
      console.error("No matching record found in Biaw Classes table");
      return res.status(404).send({ message: "No matching class found for the provided Airtable ID." });
    }

    const classRecordId = classRecords[0].id; // Get the record ID for the class

    // Step 2: Create a new record in the main table with a reference to the class
    const newRecord = await base(AIRTABLE_TABLE_NAME4).create([
      {
        fields: {
          'Mail ID': loginDetails,
          'Client ID': loginMember,
          'Class Name': className,
          'Instructor': instructor,
          'Class Airtable ID': classId,
          'Class Airtables ID': [classRecordId], // Link to the related class
          'Class URL': classur,
        },
      },
    ]);

    // Step 3: Send email notification to the user
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: process.env.EMAIL_USER, // Your email address
        pass: process.env.EMAIL_PASSWORD, // Your email app password
      },
    });

    const userMailOptions = {
      from: `"BIAW Support" <${process.env.EMAIL_USER}>`, // Sender's email address
      to: loginDetails, // Recipient's email address
      subject: 'You are on the Waitlist for the Class',
      text: `Hi there,

We saw that you are interested in the class "${className}" by ${instructor}. We have added you to the waitlist and will inform you as soon as a seat becomes available.

Thank you for your patience!

Best regards,
BIAW Support`,
    };

    const adminMailOptions = {
      from: `"BIAW Support" <${process.env.EMAIL_USER}>`,
      to: "abinjosephonline.in@gmail.com", // Admin email address
      subject: 'New Waitlist Entry Notification',
      text: `Hello Admin,

A new person has been added to the waitlist for the class:

Class Name: ${className}
Instructor: ${instructor}
User Email: ${loginDetails}
Class ID: ${classId}
Class URL: ${classur}

Please review the details and proceed as necessary.

Best regards,
The System`,
    };

    transporter.sendMail(userMailOptions, (error, info) => {
      if (error) {
        console.error('Error sending email to user:', error);
        return res.status(500).json({ message: 'Record created, but user email notification failed.', error: error.message });
      } else {
        console.log('User email sent:', info.response);

        // Send email notification to admin
        transporter.sendMail(adminMailOptions, (adminError, adminInfo) => {
          if (adminError) {
            console.error('Error sending email to admin:', adminError);
            return res.status(500).json({ message: 'Record created, but admin email notification failed.', error: adminError.message });
          } else {
            console.log('Admin email sent:', adminInfo.response);
            return res.status(201).json({ message: 'Record created and emails sent successfully.', record: newRecord });
          }
        });
      }
    });
  } catch (err) {
    console.error('Error saving to Airtable:', err);
    res.status(500).json({ message: 'Error saving to Airtable.', error: err.message });
  }
});


//class registration form submission
app.use(bodyParser.json());


app.post('/submit-class', async (req, res) => {
  const {
    SignedMemberName,
    signedmemberemail,
    timestampField,
    priceId,
    numberOfSeats,
    ...fields
  } = req.body;

  try {
    // Validate inputs
    if (!priceId || typeof priceId !== 'string' || !numberOfSeats || isNaN(numberOfSeats) || numberOfSeats <= 0) {
      return res.status(400).send({ message: 'Invalid price ID or seat count.' });
    }

    // Calculate total payment
    const totalPayment = numberOfSeats * parseFloat(fields.pricePerSeat || 0);
    if (totalPayment <= 0) {
      return res.status(400).send({ message: 'Invalid total payment amount.' });
    }

    // Validate "User ID" (field-2) against "Member ID" in the Members table
    const userId = fields['field-2'];
    if (!userId) {
      return res.status(400).send({ message: 'User ID is required and must be a valid Member ID.' });
    }

    const memberValidation = await airtable
      .base(AIRTABLE_BASE_ID)("Members")
      .select({
        filterByFormula: `{Member ID} = '${userId}'`,
        maxRecords: 1,
      })
      .firstPage();

    if (memberValidation.length === 0) {
      return res.status(400).send({ message: `Invalid Member ID: ${userId}. No matching record found in the Members table.` });
    }

    const validMemberId = memberValidation[0].id; // Airtable record ID for the matched Member

    // Fetch Biaw Class ID from Airtable
    const airID = fields['airtable-id'];
    const biawClassesTables = await airtable.base(AIRTABLE_BASE_ID)("Biaw Classes")
      .select({
        filterByFormula: `{Field ID} = '${airID}'`,
        maxRecords: 1,
      })
      .firstPage();

    if (biawClassesTables.length === 0) {
      return res.status(500).send({ message: 'No matching class found for the provided Airtable ID.' });
    }

    const biawClassId = biawClassesTables[0].id;

    // Initialize variables for seat records
    const seatRecords = [];
    const seatRecordIds = [];
    let seatCount = 0;

    // Process participants (P1 to P10)
    for (let i = 1; i <= 10; i++) {
      const name = fields[`P${i}-Name`];
      const email = fields[`P${i}-Email`];
      const phone = fields[`P${i}-Phone-number`] || fields[`P${i}-Phone-Number`];

      if (!name && !email && !phone) continue;

      seatCount++;

      // Create seat record
      const seatRecord = {
        Name: name || "",
        Email: email || "",
        "Phone Number": phone || "",
        "Time Stamp": timestampField,
        "Purchased class Airtable ID": airID,
        "Payment Status": "Pending",
        "Biaw Classes": [biawClassId],
      };

      const createdSeatRecord = await airtable
        .base(AIRTABLE_BASE_ID)(AIRTABLE_TABLE_NAME2)
        .create(seatRecord);

      seatRecords.push(seatRecord);
      seatRecordIds.push(createdSeatRecord.id);
    }

    // Create payment record in Airtable
    const paymentRecord = {
      Name: SignedMemberName,
      Email: signedmemberemail,
      "User ID": [validMemberId], // Airtable record ID for the Member
      "Airtable id": airID,
      "Client name": SignedMemberName,
      "Payment Status": "Pending",
      "Biaw Classes": [biawClassId],
      "Multiple Class Registration": seatRecordIds,
      "Number of seat Purchased": seatCount,
      "Booking Type": "User booked",
      "ROII member": "No",
      "Purchased Class url": fields['class-url'],
    };

    const paymentCreatedRecord = await airtable
      .base(AIRTABLE_BASE_ID)("Payment Records")
      .create(paymentRecord);

    // Create Stripe Checkout session
    const session = await stripe.checkout.sessions.create({
      line_items: [
        {
          price: priceId,
          quantity: numberOfSeats,
        },
      ],
      mode: 'payment',
      allow_promotion_codes: true,
      success_url: 'https://biaw-stage-api.webflow.io/thank-you',
      cancel_url: 'https://biaw-stage-api.webflow.io/payment-declined',
      client_reference_id: paymentCreatedRecord.id,
      metadata: {
        signedmemberemail,
        SignedMemberName,
        seatCount,
        totalPayment,
      },
    });

    // Respond with the Stripe Checkout URL
    res.status(200).send({
      message: 'Class registered successfully',
      records: seatRecords,
      paymentRecord: paymentCreatedRecord,
      checkoutUrl: session.url,
    });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).send({
      message: 'Error registering class',
      error: error.message,
    });
  }
});


app.post('/register-class', async (req, res) => {
  const { memberid, ...fields } = req.body;
  const timestampField = Math.floor(Date.now() / 1000);


  try {
    // Validate Member ID (ensure it exists in the "Members" table)
    if (!memberid) {
      return res.status(400).send({ message: "Member ID is required." });
    }

    const memberValidation = await airtable
      .base(AIRTABLE_BASE_ID)("Members")
      .select({
        filterByFormula: `{Member ID} = '${memberid}'`,
        maxRecords: 1,
      })
      .firstPage();

    if (memberValidation.length === 0) {
      return res.status(400).send({ message: `Invalid Member ID: ${memberid}. No matching record found in the Members table.` });
    }

    const validMemberId = memberValidation[0].id; // Airtable record ID for the matched Member

    const seatRecords = [];
    const seatRecordIds = [];
    const registeredNames = [];
    let seatCount = 0;

    // Loop through the submitted fields dynamically
    for (let i = 1; i <= 10; i++) {
      const Rname = fields[`Roii-P-${i}-Name`];
      const Remail = fields[`Roii-P-${i}-Email`] || fields[`P${i}-Email-2`];
      const Rphone = fields[`Roii-P-${i}-Phone-Number`] || fields[`P${i}-Phone-Number-2`];
      const airID = fields['airtable-id'];

      // Skip empty seat data
      if (!Rname && !Remail && !Rphone) {
        continue;
      }

      // Increment seat count for non-empty names
      if (Rname) {
        seatCount++;
      }

      const biawClassesTables = await airtable.base(AIRTABLE_BASE_ID)("Biaw Classes")
        .select({
          filterByFormula: `{Field ID} = ${airID}`,
          maxRecords: 1,
        })
        .firstPage();

      if (biawClassesTables.length === 0) {
        console.error("No matching record found in Biaw Classes table");
        return res.status(500).send({ message: "No matching class found for the provided Airtable ID." });
      }

      const biawClassRecords = biawClassesTables[0];
      const biawClassIds = biawClassRecords.id;

      const seatRecord = {
        "Name": Rname || "",
        "Email": Remail || "",
        "Phone Number": Rphone || "",
        "Time Stamp": timestampField,
        "Purchased class Airtable ID": airID,
        "Biaw Classes": [biawClassIds],
        "Payment Status": "ROII Free"
      };

      seatRecords.push(seatRecord);
    }

    const createdRecords = [];
    for (const record of seatRecords) {
      const createdRecord = await airtable
        .base(AIRTABLE_BASE_ID)(AIRTABLE_TABLE_NAME2)
        .create(record);

      createdRecords.push(createdRecord);
      seatRecordIds.push(createdRecord.id);
      registeredNames.push(record["Name"]);
    }

    const biawClassesTable = await airtable.base(AIRTABLE_BASE_ID)("Biaw Classes")
      .select({
        filterByFormula: `{Field ID} = '${fields['airtable-id']}'`,
        maxRecords: 1,
      })
      .firstPage();

    if (biawClassesTable.length === 0) {
      console.error("No matching record found in Biaw Classes table");
      return res.status(500).send({ message: "No matching class found for the provided Airtable ID." });
    }

    const biawClassRecord = biawClassesTable[0];
    const biawClassId = biawClassRecord.id;

    let currentSeatsRemaining = parseInt(biawClassRecord.fields["Number of seats remaining"], 10);
    let totalPurchasedSeats = parseInt(biawClassRecord.fields["Total Number of Purchased Seats"] || "0", 10);
    const classlocation = biawClassRecord.fields["Local Association Name (from Location 2)"]?.[0] || "No details provided";


    if (currentSeatsRemaining < seatCount) {
      return res.status(400).send({ message: "Not enough seats available for this class." });
    }

    const updatedSeatsRemaining = currentSeatsRemaining - seatCount;

    const updatedTotalPurchasedSeats = totalPurchasedSeats + seatCount;

    try {
      await airtable.base(AIRTABLE_BASE_ID)("Biaw Classes").update(biawClassId, {
        "Number of seats remaining": updatedSeatsRemaining.toString(),
        "Total Number of Purchased Seats": updatedTotalPurchasedSeats.toString(),
      });

      console.log(`Seats successfully updated. Remaining seats: ${updatedSeatsRemaining}, Total purchased seats: ${updatedTotalPurchasedSeats}`);
    } catch (updateError) {
      console.error("Error updating the seats:", updateError);
      return res.status(500).send({ message: "Error updating the seat information", error: updateError });
    }
    const signEmail = fields['roii-signedmemberemail'];
    const signName = fields["roii-signed-member-name"];

    const paymentRecord = {
      "Name": signName,
      "Email": signEmail,
      // "Client ID": memberid,
      "User ID": [validMemberId], // Airtable record ID for the validated Member
      "Airtable id": fields['airtable-id'],
      "Client name": signName,
      "Payment Status": "ROII-Free",
      "Biaw Classes": [fields['airtable-id']],
      "Multiple Class Registration": seatRecordIds,
      "Number of seat Purchased": seatCount,
      "Biaw Classes": [biawClassId],
      "Booking Type": "User booked",
      "ROII member": "Yes",
      "Purchased Class url": fields["class-url-2"]
    };

    let paymentCreatedRecord;
    try {
      paymentCreatedRecord = await airtable
        .base(AIRTABLE_BASE_ID)("Payment Records")
        .create(paymentRecord);

      const transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: {
          user: process.env.EMAIL_USER,
          pass: process.env.EMAIL_PASSWORD,
        },
      });

      const userMailOptions = {
        from: `"BIAW Support" <${process.env.EMAIL_USER}>`,
        to: signEmail,
        subject: `Class Registration Confirmation for ${biawClassRecord.fields['Name']}`,
        html: `
          <p>Hi ${signName},</p>
           <p>You have successfully registered for the class. Here are the details:</p>
          <p>Your registration for the class <strong>${biawClassRecord.fields['Name']}</strong> has been confirmed. Below are your details:</p>
          <p>description : ${biawClassRecord.fields['Description']}</p>
          <ul>
            <li>Number of Seats Purchased: ${seatCount}</li>
            <li>Location : ${classlocation}</li>
            <li>Class Url : ${fields["class-url-2"]}</li>
          </ul>
          <p>We look forward to seeing you in class!</p>
          <p>Best regards,<br>BIAW Support</p>
        `,
      };

      await transporter.sendMail(userMailOptions);

    } catch (paymentError) {
      console.error("Error adding to Payment Records:", paymentError);
      return res.status(500).send({ message: "Error registering payment record", error: paymentError });
    }

    res.status(200).send({
      message: "Class registered successfully",
      records: createdRecords,
      paymentRecord: paymentCreatedRecord,
    });
  } catch (error) {
    console.error("Error adding records to Airtable:", error);
    res.status(500).send({ message: "Error registering class", error: error });
  }
});


const airtableBase = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(process.env.AIRTABLE_BASE_ID);



const airtableBaseURL = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${AIRTABLE_TABLE_NAME3}`;
const airtableHeaders = {
  Authorization: `Bearer ${AIRTABLE_API_KEY}`,
};

// Webflow API Configuration
const webflowBaseURL = `https://api.webflow.com/v2/collections/${WEBFLOW_COLLECTION_ID2}/items`;
const webflowHeaders = {
  Authorization: `Bearer ${WEBFLOW_API_KEY}`,
  "Content-Type": "application/json",
  Accept: "application/json",
};

// async function syncAirtableToWebflow() {
//   try {
//     // Fetch Airtable data
//     const airtableResponse = await axios.get(airtableBaseURL, { headers: airtableHeaders });
//     const airtableRecords = airtableResponse.data.records;

//     console.log(`Fetched ${airtableRecords.length} records from Airtable.`);

//     // Fetch existing Webflow records
//     let existingWebflowRecords = [];
//     try {
//       const webflowResponse = await axios.get(webflowBaseURL, { headers: webflowHeaders });
//       existingWebflowRecords = webflowResponse.data.items || [];
//     } catch (webflowError) {
//       console.error("Error fetching records from Webflow:", webflowError.response?.data || webflowError.message);
//     }

//     const webflowRecordIds = new Set(
//       existingWebflowRecords.map(record => record.fieldData["purchase-record-airtable-id"])
//     );

//     for (const record of airtableRecords) {
//       const airtableRecordId = record.id;
//       const paymentStatus = record.fields["Payment Status"];
//       const refundConfirmation = record.fields["Refund Confirmation"];

//       // Skip records with "Payment Status" as "Pending"
//       if (paymentStatus === "Pending") {
//         console.log(`Skipping record with Airtable ID ${airtableRecordId} due to Pending Payment Status.`);
//         continue;
//       }

//       // Check if "Refund Confirmation" is required
//       const requiresRefundConfirmation = ["ROII-Cancelled", "Cancelled Without Refund", "Refunded"].includes(paymentStatus);
//       if (requiresRefundConfirmation && refundConfirmation !== "Confirmed") {
//         console.log(
//           `Skipping record with Airtable ID ${airtableRecordId} as "Refund Confirmation" is not Confirmed for Payment Status: ${paymentStatus}.`
//         );
//         continue;
//       }

//       console.log(`Processing record with Airtable ID ${airtableRecordId} for Payment Status: ${paymentStatus}.`);

//       const biawClassesDetails = [];
//       if (record.fields["Biaw Classes"]) {
//         for (const classId of record.fields["Biaw Classes"]) {
//           try {
//             const classResponse = await axios.get(`${airtableBaseURL}/${classId}`, { headers: airtableHeaders });
//             biawClassesDetails.push(classResponse.data.fields);
//           } catch (classError) {
//             console.error(`Error fetching Biaw Class details for ID ${classId}:`, classError.response?.data || classError.message);
//           }
//         }
//       }

//       // console.log(`Retrieved Biaw Classes details:`, biawClassesDetails);
//       const memberid = record.fields["Member ID (from User ID)"]?.[0] || "No details provided"; //new feild
//       const classFieldValue1 = record.fields["Field ID (from Biaw Classes)"]?.[0] || "No details provided"; //new feild

//       const webflowData = {
//         fieldData: {
//           name: biawClassesDetails[0]?.Name || "",
//           _archived: false,
//           _draft: false,
//           "field-id": String(classFieldValue1),
//           // "member-id": record.fields["Client ID"],
//           "member-id": memberid,//new filed
//           "mail-id": record.fields["Email"],
//           "total-amount": record.fields["Amount Total"] || "Free",
//           "purchase-class-name": biawClassesDetails[0]?.Name || "",
//           "purchased-class-end-date": biawClassesDetails[0]?.["End date"] || "",
//           "purchased-class-end-time": biawClassesDetails[0]?.["End Time"] || "",
//           "purchased-class-start-date": biawClassesDetails[0]?.Date || "",
//           "purchased-class-start-time": biawClassesDetails[0]?.["Start Time"] || "",
//           "payment-status": paymentStatus,
//           "banner-image": biawClassesDetails[0]?.Images?.[0]?.url || "",
//           "number-of-purchased-seats": String(record.fields["Number of seat Purchased"]),
//           "purchase-record-airtable-id": airtableRecordId,
//           "payment-intent-2": record.fields["Payment ID"],
//           "class-url": record.fields["Purchased Class url"] || "",
//           "purchase-type-2": record.fields["Booking Type"] || "",
//         },
//       };

//       // Check if the record already exists in Webflow
//       if (webflowRecordIds.has(airtableRecordId)) {
//         const webflowRecord = existingWebflowRecords.find(r => r.fieldData["purchase-record-airtable-id"] === airtableRecordId);

//         const fieldsToUpdate = {};
//         let needsUpdate = false;

//         for (const field in webflowData.fieldData) {
//           if (field === "banner-image") continue;

//           const webflowFieldValue = String(webflowRecord.fieldData[field] || "").trim();
//           const airtableFieldValue = String(webflowData.fieldData[field] || "").trim();

//           if (webflowFieldValue !== airtableFieldValue) {
//             needsUpdate = true;
//             fieldsToUpdate[field] = webflowData.fieldData[field];
//           }
//         }

//         if (needsUpdate) {
//           console.log(`Record with Airtable ID ${airtableRecordId} has changes. Updating the following fields: ${Object.keys(fieldsToUpdate).join(", ")}`);
//           try {
//             const updateURL = `${webflowBaseURL}/${webflowRecord.id}/live`;
//             await axios.patch(updateURL, { fieldData: fieldsToUpdate }, { headers: webflowHeaders });
//             console.log(`Successfully updated record in Webflow.`);
//           } catch (webflowError) {
//             console.error(`Error updating record in Webflow:`, webflowError.response?.data || webflowError.message);
//           }
//         } else {
//           console.log(`Record with Airtable ID ${airtableRecordId} is up to date in Webflow. No update needed.`);
//         }
//       } else {
//         try {
//           const newurl = `${webflowBaseURL}/live`
//           await axios.post(newurl, webflowData, { headers: webflowHeaders });
//           console.log(`Successfully pushed new record to Webflow.`);
//         } catch (webflowError) {
//           console.error(`Error pushing new record to Webflow:`, webflowError.response?.data || webflowError.message);
//         }
//       }
//     }
//   } catch (airtableError) {
//     console.error(`Error fetching data from Airtable:`, airtableError.response?.data || airtableError.message);
//   }
// }



async function syncAirtableToWebflow() {
  try {
    // Fetch Airtable data
    const airtableResponse = await axios.get(airtableBaseURL, { headers: airtableHeaders });
    const airtableRecords = airtableResponse.data.records;

    console.log(`Fetched ${airtableRecords.length} records from Airtable.`);

    // Fetch existing Webflow records
    let existingWebflowRecords = [];
    try {
      const webflowResponse = await axios.get(webflowBaseURL, { headers: webflowHeaders });
      existingWebflowRecords = webflowResponse.data.items || [];
    } catch (webflowError) {
      console.error("Error fetching records from Webflow:", webflowError.response?.data || webflowError.message);
    }

    const webflowRecordIds = new Set(
      existingWebflowRecords.map(record => record.fieldData["purchase-record-airtable-id"])
    );

    for (const record of airtableRecords) {
      const airtableRecordId = record.id;
      const paymentStatus = record.fields["Payment Status"];
      const refundConfirmation = record.fields["Refund Confirmation"];
      const adminClassBooking = record.fields["Admin class booking"];
  
      if (adminClassBooking === "Rejected") {
      console.log(`Skipping record with Airtable ID ${airtableRecordId} due to Admin class booking being Rejected.`);
      continue;
      }

      // Skip records with "Payment Status" as "Pending"
      if (paymentStatus === "Pending") {
        console.log(`Skipping record with Airtable ID ${airtableRecordId} due to Pending Payment Status.`);
        continue;
      }

      // Check if "Refund Confirmation" is required
      const requiresRefundConfirmation = ["ROII-Cancelled", "Cancelled Without Refund", "Refunded"].includes(paymentStatus);
      if (requiresRefundConfirmation && refundConfirmation !== "Confirmed") {
        console.log(
          `Skipping record with Airtable ID ${airtableRecordId} as "Refund Confirmation" is not Confirmed for Payment Status: ${paymentStatus}.`
        );
        continue;
      }

      console.log(`Processing record with Airtable ID ${airtableRecordId} for Payment Status: ${paymentStatus}.`);

      // Retrieve details of "Biaw Classes"
      const biawClassesDetails = [];
      if (record.fields["Biaw Classes"]) {
        for (const classId of record.fields["Biaw Classes"]) {
          try {
            const classResponse = await axios.get(`${airtableBaseURL}/${classId}`, { headers: airtableHeaders });
            biawClassesDetails.push(classResponse.data.fields);
          } catch (classError) {
            console.error(`Error fetching Biaw Class details for ID ${classId}:`, classError.response?.data || classError.message);
          }
        }
      }

      const memberId = record.fields["Member ID (from User ID)"]?.[0] || "No details provided";
      const classFieldValue1 = record.fields["Field ID (from Biaw Classes)"]?.[0] || "No details provided";

      const webflowData = {
        fieldData: {
          name: biawClassesDetails[0]?.Name || "",
          _archived: false,
          _draft: false,
          "field-id": String(classFieldValue1),
          "member-id": memberId,
          "mail-id": record.fields["Email"],
          "total-amount": record.fields["Amount Total"] || "Free",
          "purchase-class-name": biawClassesDetails[0]?.Name || "",
          "purchased-class-end-date": biawClassesDetails[0]?.["End date"] || "",
          "purchased-class-end-time": biawClassesDetails[0]?.["End Time"] || "",
          "purchased-class-start-date": biawClassesDetails[0]?.Date || "",
          "purchased-class-start-time": biawClassesDetails[0]?.["Start Time"] || "",
          "payment-status": paymentStatus,
          "banner-image": biawClassesDetails[0]?.Images?.[0]?.url || "",
          "number-of-purchased-seats": String(record.fields["Number of seat Purchased"]),
          "purchase-record-airtable-id": airtableRecordId,
          "payment-intent-2": record.fields["Payment ID"],
          "class-url": record.fields["Purchased Class url"] || "",
          "purchase-type-2": record.fields["Booking Type"] || "",
        },
      };

      // Check if the record already exists in Webflow
      if (webflowRecordIds.has(airtableRecordId)) {
        const webflowRecord = existingWebflowRecords.find(
          r => r.fieldData["purchase-record-airtable-id"] === airtableRecordId
        );

        const fieldsToUpdate = {};
        let needsUpdate = false;

        for (const field in webflowData.fieldData) {
          if (field === "banner-image") continue; // Skip non-updatable field

          const webflowFieldValue = String(webflowRecord.fieldData[field] || "").trim();
          const airtableFieldValue = String(webflowData.fieldData[field] || "").trim();

          // Skip fields that are being cleared
          if (!airtableFieldValue && webflowFieldValue) {
            console.log(`Skipping field "${field}" as it cannot be cleared.`);
            continue;
          }

          if (webflowFieldValue !== airtableFieldValue) {
            needsUpdate = true;
            fieldsToUpdate[field] = webflowData.fieldData[field];
          }
        }

        if (needsUpdate) {
          console.log(`Record with Airtable ID ${airtableRecordId} has changes. Updating fields: ${Object.keys(fieldsToUpdate).join(", ")}`);
          try {
            const updateURL = `${webflowBaseURL}/${webflowRecord.id}/live`;
            await axios.patch(updateURL, { fieldData: fieldsToUpdate }, { headers: webflowHeaders });
            console.log(`Successfully updated record in Webflow.`);
          } catch (webflowError) {
            console.error(`Error updating record in Webflow:`, webflowError.response?.data || webflowError.message);
          }
        } else {
          console.log(`Record with Airtable ID ${airtableRecordId} is up to date in Webflow.`);
        }
      } else {
        try {
          const createURL = `${webflowBaseURL}/live`;
          await axios.post(createURL, webflowData, { headers: webflowHeaders });
          console.log(`Successfully pushed new record to Webflow.`);
        } catch (webflowError) {
          console.error(`Error pushing new record to Webflow:`, webflowError.response?.data || webflowError.message);
        }
      }
    }
  } catch (airtableError) {
    console.error(`Error fetching data from Airtable:`, airtableError.response?.data || airtableError.message);
  }
}

syncAirtableToWebflow();


async function runPeriodically(intervalMs) {
  console.log("Starting periodic sync...");
  setInterval(async () => {
    console.log(`Running sync at ${new Date().toISOString()}`);
    await syncAirtableToWebflow();
  }, intervalMs);
}

runPeriodically(30 * 1000);


// Periodic processing of new classes
async function processNewClassesPeriodically() {
  if (isProcessing) {
    console.log("Another process is already running. Skipping this cycle.");
    return;
  }

  isProcessing = true;
  try {
    console.log("Starting periodic class processing...");
    await processNewClasses();
    console.log("Periodic processing completed.");
  } catch (error) {
    logError("Periodic Class Processing", error);
  } finally {
    isProcessing = false;
  }
}

// Start periodic processing every 30 seconds
setInterval(processNewClassesPeriodically, 30 * 1000);


const stripe3 = require('stripe')('sk_test_51Q9sSHE1AF8nzqTaSsnaie0CWSIWxwBjkjZpStwoFY4RJvrb87nnRnJ3B5vvvaiTJFaSQJdbYX0wZHBqAmY2WI8z00hl0oFOC8');  // Stripe Secret Key

// POST endpoint to cancel payment and refund

app.post('/cancel-payment', async (req, res) => {
  const { airtableRecordId, paymentIntentId } = req.body;

  if (!airtableRecordId) {
    return res.status(400).json({ message: "Missing Airtable Record ID" });
  }

  try {
    // Fetch the payment record from Airtable
    const airtableURL = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${AIRTABLE_TABLE_NAME3}/${airtableRecordId}`;
    const recordResponse = await axios.get(airtableURL, {
      headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}` },
    });

    const recordData = recordResponse.data.fields;
    const currentPaymentStatus = recordData["Payment Status"];
    const seatCount = recordData["Number of seat Purchased"];
    const classID = recordData["Biaw Classes"][0];
    const multipleClassRegistrationIds = recordData["Multiple Class Registration"] || [];
    const userEmail = recordData["Email"];
    const userName = recordData["Name"];
    const classurled = recordData['Purchased Class url']
    const cancellationDate = new Date().toISOString();

    // Determine the new payment status
    let newPaymentStatus = "Refunded";
    if (currentPaymentStatus === "ROII-Free" || currentPaymentStatus === "ROII-Cancelled") {
      newPaymentStatus = "ROII-Cancelled";
    }

    // Prepare the update payload for payment status
    const fieldsToUpdate = {
      "Payment Status": newPaymentStatus,
      "Refund Confirmation": "Confirmed",
    };

    // If the status is updated to "ROII-Cancelled" or "Refunded", update seat purchased to 0
    if (newPaymentStatus === "ROII-Cancelled" || newPaymentStatus === "Refunded") {
      fieldsToUpdate["Number of seat Purchased"] = 0;
    }

    // Update payment status in Payment Records
    await axios.patch(
      airtableURL,
      { fields: fieldsToUpdate },
      { headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}`, "Content-Type": "application/json" } }
    );

    // Update the "Biaw Classes" table with seat adjustments
    const biawClassesURL = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/Biaw Classes/${classID}`;
    const biawClassResponse = await axios.get(biawClassesURL, {
      headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}` },
    });

    const currentSeatsRemaining = parseInt(biawClassResponse.data.fields["Number of seats remaining"], 10);
    const totalPurchasedSeats = parseInt(biawClassResponse.data.fields["Total Number of Purchased Seats"] || "0", 10);
    const className = biawClassResponse.data.fields["Name"]; // Fetch the class name


    // Update seats remaining and total purchased seats
    const updatedSeatsRemaining = currentSeatsRemaining + seatCount;
    const updatedTotalPurchasedSeats = totalPurchasedSeats - seatCount;

    await axios.patch(
      biawClassesURL,
      {
        fields: {
          "Number of seats remaining": updatedSeatsRemaining.toString(),
          "Total Number of Purchased Seats": updatedTotalPurchasedSeats.toString(),
        },
      },
      { headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}`, "Content-Type": "application/json" } }
    );

    // Update the "Multiple Class Registration" table
    for (const multipleClassId of multipleClassRegistrationIds) {
      const multipleClassURL = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${AIRTABLE_TABLE_NAME2}/${multipleClassId}`;

      await axios.patch(
        multipleClassURL,
        {
          fields: {
            "Payment Status": newPaymentStatus,
          },
        },
        { headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}`, "Content-Type": "application/json" } }
      );
    }

    console.log(`Updated payment status for multiple class registrations and payment records`);

    // Proceed with Stripe Refund only if paymentIntentId is provided
    let refundId = null;
    let refundAmount = null;
    if (paymentIntentId && newPaymentStatus === "Refunded") {
      const refund = await stripe3.refunds.create({
        payment_intent: paymentIntentId,
      });

      console.log("Refund successful:", refund);
      refundId = refund.id;
      refundAmount = (refund.amount / 100).toFixed(2);
    }

    // Send email notification
    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASSWORD,
      },
    });

    let emailSubject = `Class Cancellation Confirmation ${className}`;
    let emailBody = `
      <p>Dear ${userName},</p>
      <p>We’ve received your request to cancel the class, and we’re writing to confirm that the cancellation has been processed successfully.</p>
      <p>Details of Your Cancellation:</p>
      <ul>
        <li>Class: ${className}</li>
        <li>Class Url: ${classurled}</li>
        <li>Date of Cancellation: ${cancellationDate}</li>
    `;

    if (newPaymentStatus === "Refunded") {
      emailBody += `
        <li>Refund Amount: ${refundAmount} USD</li>
      </ul>
      <p>Please allow 15 business days for the refund to reflect in your account, depending on your payment provider.</p>
      `;
    } else {
      emailBody += `
      </ul>
      <p>Your registration has been successfully canceled.</p>
      `;
    }

    emailBody += `
      <p>If you have any questions or need further assistance, feel free to contact us at [Support Email/Phone].</p>
      <p>Thank you for your understanding, and we hope to see you again soon.</p>
      <p>Best regards,<br>BIAW Support</p>
    `;

    const mailOptions = {
      from: `"BIAW Support" <${process.env.EMAIL_USER}>`,
      to: userEmail,
      subject: emailSubject,
      html: emailBody,
    };

    transporter.sendMail(mailOptions, (error, info) => {
      if (error) {
        console.error("Failed to send email:", error.message);
      } else {
        console.log(`Cancellation email sent to ${userEmail}: ${info.response}`);
      }
    });

    res.status(200).json({
      message: "Payment status updated, class seat adjusted, and email sent.",
      recordId: airtableRecordId,
      refundId: refundId || "No refund needed",
    });
  } catch (error) {
    console.error("Error processing the payment cancellation and refund:", error.message);
    res.status(500).json({ message: "Failed to process refund and update records", error: error.message });
  }
});

// Initialize Airtable base
const base4 = new Airtable({ apiKey: AIRTABLE_API_KEY }).base(AIRTABLE_BASE_ID);

async function checkAndNotify() {
  try {
    const jointWaitlistRecords = await base4('Joint waitlist')
      .select({
        filterByFormula: `{Notified} = "Yet to Notify"`, // Only fetch records where Notified is "Yet to Notify"
      })
      .all();

    const classDetailsCache = {};

    // Fetch class details and cache them
    for (const record of jointWaitlistRecords) {
      const classIds = record.get('Class Airtables ID');

      // Skip records with no Class Airtables ID or empty array
      if (!classIds || classIds.length === 0) {
        console.warn(`Record ${record.id} in "Joint waitlist" has no valid "Class Airtables ID".`);
        continue;
      }

      const classId = classIds[0]; // Take the first ID from the array

      if (!classDetailsCache[classId]) {
        try {
          const classRecord = await base4('Biaw Classes').find(classId);
          classDetailsCache[classId] = {
            seatsRemaining: classRecord.get('Number of seats remaining'),
            className: classRecord.get('Name'), // Optional field for email personalization
          };
        } catch (error) {
          console.error(`Failed to fetch class details for ID ${classId}:`, error.message);
        }
      }
    }

    // Process waitlist and send notifications
    for (const record of jointWaitlistRecords) {
      const classIds = record.get('Class Airtables ID');

      if (!classIds || classIds.length === 0) {
        console.warn(`Skipping record ${record.id}: No valid Class Airtables ID.`);
        continue;
      }

      const classId = classIds[0]; // Take the first ID from the array
      const email = record.get('Mail ID'); // Ensure this field exists in your Airtable

      if (!classDetailsCache[classId]) {
        console.warn(`Skipping record ${record.id}: Class details not found for ID ${classId}.`);
        continue;
      }

      const { seatsRemaining, className } = classDetailsCache[classId];

      if (seatsRemaining > 0) {
        const message = {
          from: `"BIAW Support" <${process.env.EMAIL_USER}>`,
          to: email,
          subject: `Seats Available for ${className || 'Your Class'}`,
          text: `Hello ${record.get('Name') || ''}, 

There are ${seatsRemaining} seats now available for ${className || 'the class'}. If you would like to purchase a seat, you can do so now!

If you have any questions or need further assistance, feel free to contact us at [Support Email/Phone].

Thank you for your understanding and patience, and we hope to see you again soon.

Best regards,
BIAW Support`,
        };

        await transporter.sendMail(message);
        console.log(`Email sent to ${email} for class: ${className || classId}`);

        // Mark the user as notified in Airtable
        try {
          await base4('Joint waitlist').update(record.id, {
            "Notified": "Notified", // Update the Notified field
          });
          console.log(`Marked record ${record.id} as notified.`);
        } catch (updateError) {
          console.error(`Failed to mark record ${record.id} as notified:`, updateError.message);
        }
      }
    }
  } catch (error) {
    console.error('Error checking or notifying:', error);
  }
}

async function runPeriodicallyswe(intervalMs) {
  console.log("Starting periodic sync...");
  setInterval(async () => {
    console.log(`Running sync at ${new Date().toISOString()}`);
    await checkAndNotify();
  }, intervalMs);
}



runPeriodicallyswe(50 * 1000);

const airtableBaseURL4 = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/Category`;
const airtableHeaders4 = {
  Authorization: `Bearer ${AIRTABLE_API_KEY}`,
};

// Webflow API Configuration
const webflowBaseURL4 = `https://api.webflow.com/v2/collections/${WEBFLOW_COLLECTION_ID3}/items`;
const webflowHeaders4 = {
  Authorization: `Bearer ${WEBFLOW_API_KEY}`,
  "Content-Type": "application/json",
  Accept: "application/json",
};

async function syncCategoriesToWebflow() {
  try {
    const airtableCategories = (await axios.get(airtableBaseURL4, { headers: airtableHeaders4 })).data.records;
    console.log(`Fetched ${airtableCategories.length} categories from Airtable.`);

    const existingWebflowCategories = (await axios.get(webflowBaseURL4, { headers: webflowHeaders4 })).data.items || [];
    const webflowCategoriesByAirtableId = existingWebflowCategories.reduce((acc, record) => {
      (acc[record.fieldData["category-airtable-id"]] ||= []).push(record);
      return acc;
    }, {});

    for (const { id: airtableCategoryId, fields } of airtableCategories) {
      const {
        "Category Name": name,
        "Related Classes": relatedClasses,
        "Item Id (from Biaw Classes)": memberIds = [],
        "Item Id 2 (from Biaw Classes)": nonMemberIds = [],
        status,
      } = fields;

      const categoriesToProcess = [
        { name, "related-classes": await validateWebflowItemIds(memberIds), "member-non-member": "Yes" },
        { name, "related-classes": await validateWebflowItemIds(nonMemberIds), "member-non-member": "No" },
      ].map(data => ({ fieldData: { ...data, "category-airtable-id": airtableCategoryId } }));

      for (const categoryData of categoriesToProcess) {
        const existingRecords = webflowCategoriesByAirtableId[airtableCategoryId]?.filter(
          record => record.fieldData["member-non-member"] === categoryData.fieldData["member-non-member"]
        ) || [];

        if (existingRecords.length) {
          // Update existing records if the status is "Updated"
          if (status === "Updated") {
            for (const record of existingRecords) {
              const updates = Object.fromEntries(
                Object.entries(categoryData.fieldData).filter(([key, value]) =>
                  (record.fieldData[key] || "").toString() !== value.toString()
                )
              );
              if (Object.keys(updates).length) {
                console.log(`Updating Webflow record ${record.id} with changes:`, Object.keys(updates));
                await axios.patch(`${webflowBaseURL4}/${record.id}/live`, { fieldData: updates }, { headers: webflowHeaders4 });
                console.log(`Updating Airtable status for record ID: ${airtableCategoryId} to "Published".`);
                await axios.patch(`${airtableBaseURL4}/${airtableCategoryId}`, {
                  fields: { status: "Published" },
                }, { headers: airtableHeaders4 });
              } else {
                console.log(`Webflow record ${record.id} is up to date.`);
              }
            }
          }
        } else {
          // Create a new category if the status is "Publish"
          if (status === "Publish") {
            console.log(`Creating new category for Airtable ID ${airtableCategoryId}.`);
            await axios.post(`${webflowBaseURL4}/live`, categoryData, { headers: webflowHeaders4 });
            console.log(`Updating Airtable status for record ID: ${airtableCategoryId} to "Published".`);
            await axios.patch(`${airtableBaseURL4}/${airtableCategoryId}`, {
              fields: { status: "Published" },
            }, { headers: airtableHeaders4 });
          }
        }
      }
    }
  } catch (error) {
    console.error("Error during synchronization:", error.response?.data || error.message);
  }
}

syncCategoriesToWebflow();

async function runPeriodicallycate(intervalMs) {
  console.log("Starting periodic sync...");
  setInterval(async () => {
    console.log(`Running sync at ${new Date().toISOString()}`);
    await syncCategoriesToWebflow();
  }, intervalMs);
}

runPeriodicallycate(50 * 1000)


app.post('/api/special', async (req, res) => {
  const { id, fields } = req.body;

  // Log the received data for debugging
  console.log('Received data:', { id, fields });

  try {
    // Extract fields from the received data
    const name = fields.Name || 'Untitled';
    const description = fields.Description || 'No description available';
    const mainImages = fields.Image?.[0]?.thumbnails?.large?.url || '';  // Extract image URL if present
    const roiiSpecialClassLink = fields.Link || '';  // URL for special class link
    const startDate = fields['Start Date'] || '';  // Extract start date
    const endDate = fields['End Date'] || '';

    // Debugging the extracted fields
    console.log('Extracted fields:', { name, description, mainImages, roiiSpecialClassLink ,startDate ,endDate });

    // Webflow item IDs (to be updated in Airtable later)
    let memberItemId;
    let nonMemberItemId;

    // Loop for both "Member" and "Non-Member" cases
    for (const dropdownValue of ['Member', 'Non-Member']) {
      const isMember = dropdownValue === 'Member';
      const memberValue = isMember ? 'Yes' : 'No';
      const nonMemberValue = isMember ? 'No' : 'Yes';

      // Generate a slug for Webflow
      const slug = `${name}-${dropdownValue}`.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');

      // Construct the Webflow payload
      const webflowPayload = {
        fieldData: {
          name: name,
          slug: slug,
          description: description,
          'roii-special-class-link': roiiSpecialClassLink,
          'main-images': mainImages,
          member: memberValue,
          'non-member': nonMemberValue,
          'member-non-member': dropdownValue,
          "banner-image":mainImages,
           date: startDate, 
          'end-date': endDate ,
        },
      };

      try {
        const webflowResponse = await axios.post(
          `https://api.webflow.com/v2/collections/${WEBFLOW_COLLECTION_ID}/items/live`,
          webflowPayload,
          {
            headers: {
              Authorization: `Bearer ${WEBFLOW_API_KEY}`,
              'Content-Type': 'application/json',
            },
          }
        );

        // Get the Webflow CMS item ID from the response
        const webflowItemId = webflowResponse.data.id;
        console.log(`Successfully added ${dropdownValue} item to Webflow:`, webflowItemId);

        // Store the Webflow item IDs for later use in Airtable update
        if (dropdownValue === 'Member') {
          memberItemId = webflowItemId;
        } else if (dropdownValue === 'Non-Member') {
          nonMemberItemId = webflowItemId;
        }

      } catch (webflowError) {
        console.error('Error syncing data to Webflow:', webflowError.response?.data || webflowError.message);
        throw webflowError; // Propagate the error
      }
    }

    // Once both Webflow item IDs are retrieved, update Airtable
    if (memberItemId && nonMemberItemId) {
      const airtableUpdatePayload = {
        fields: {
          'Webflow Item ID (Member)': memberItemId,
          'Webflow Item ID (Non member)': nonMemberItemId,
        },
      };

      // Update Airtable with the Webflow item IDs
      await axios.patch(
        `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${AIRTABLE_TABLE_NAME5}/${id}`,
        airtableUpdatePayload,
        {
          headers: {
            Authorization: `Bearer ${AIRTABLE_API_KEY}`,
            'Content-Type': 'application/json',
          },
        }
      );

      console.log(`Updated Airtable with Webflow CMS IDs: Member - ${memberItemId}, Non-Member - ${nonMemberItemId}`);
    }

    // Send a success response if everything went well
    res.status(200).json({ message: 'Data processed and synced successfully.' });

  } catch (error) {
    // Send error response if something goes wrong
    console.error('Error syncing data:', error.message);
    res.status(500).json({ message: 'Error syncing data', error: error.message });
  }
});


app.post("/api/mail", async (req, res) => {

  const { id, fields } = req.body;

  // Log the received data for debugging
  console.log('Received data:', { id, fields });
  try {

      const email = fields["Email"];
      const paymentStatus = fields["Payment Status"]?.name;
      const purchaseclassurl = fields["Purchased Class url"] //["Field ID (from Biaw Classes)"]?.[0] || null
      const uername = fields["Name"]
      const classname = fields["Name (from Biaw Classes)"]?.[0] || null

      if (paymentStatus !== "Pending") {
          return res.status(400).json({ error: "Payment is not pending" });
      }

      // Send email
      const mailOptions = {
          from:`"BIAW Support" <${process.env.EMAIL_USER}>`,
          to: email,
          subject: "Reminder: Complete Your Payment",
          text: `Hi ${uername}, 
          
          you registered for the class ${classname}

          but haven't completed your payment. Please complete it to confirm your seat.

          here is your class url ${purchaseclassurl} `,
      };

      await transporter.sendMail(mailOptions);

      console.log(`Email sent to ${email}`);

      // ✅ Update Airtable field "Mail" to "Mailed"
      await base(process.env.AIRTABLE_TABLE_NAME3).update([
          {
              id: id,
              fields: {
                  Mail: "Mailed",
              },
          },
      ]);

      console.log(`Updated Airtable record ${id}: "Mail" set to "Mailed"`);

      res.status(200).json({ message: "Email sent and Airtable updated" });
  } catch (error) {
      console.error("Error:", error);
      res.status(500).json({ error: "Internal Server Error" });
  }
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});


