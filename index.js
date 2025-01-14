const Airtable = require('airtable');
const Stripe = require('stripe');
const express = require('express');
const cors = require("cors");
const axios = require('axios');
const cron = require('node-cron');
const bodyParser = require('body-parser');

require('dotenv').config();

const app = express();

Airtable.configure({
  apiKey: process.env.AIRTABLE_API_KEY,
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
    const checkid = session.id

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
          "Payment record id":checkid,
        });
        console.log(`Payment record (${clientReferenceId}) updated successfully.`);
      } else {
        console.warn(`No matching Airtable record found for clientReferenceId: ${clientReferenceId}`);
      }

      // Proceed to update class and field data
      const lastRecord = matchingRecord; 
      const seatCount = parseInt(lastRecord.fields['Number of seat Purchased'], 10);
      const classFieldValue = lastRecord.fields['Airtable id'];
      const multipleClassRegistrationIds = lastRecord.fields['Multiple Class Registration'] || [];

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
        `Class record updated. Remaining seats: ${
          currentSeatsRemaining - seatCount
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

// Fetch new records from Airtable
async function fetchNewClasses() {
  try {
    const records = await airtable
      .base(AIRTABLE_BASE_ID)(AIRTABLE_TABLE_NAME)
      .select({ filterByFormula: "NOT({Item Id})" })
      .all();
    console.log("Fetched new records from Airtable:", records.map((rec) => rec.fields));
    return records.map((record) => ({ id: record.id, ...record.fields }));
  } catch (error) {
    logError("Fetching Airtable Records", error);
    return [];
  }
}

// Create a product and prices in Stripe
async function createStripeProducts(classDetails) {
  try {
    if (!classDetails.Name || !classDetails["Price - Member"] || !classDetails["Price - Non Member"]) {
      throw new Error("Class details are incomplete");
    }

    const memberPriceAmount = parsePrice(classDetails["Price - Member"]);
    const nonMemberPriceAmount = parsePrice(classDetails["Price - Non Member"]);

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
    .replace(/\s+/g, '-')

  const cleanedDropdownValue = dropdownValue.toLowerCase().replace(/\s+/g, '-');

  return `${cleanedName}-${cleanedDropdownValue}`;
}

// function to add cms class
async function addToWebflowCMS(classDetails, stripeInfo) {
  try {
    const instructorName = Array.isArray(classDetails["Instructor Name (from Instructors)"])
      ? classDetails["Instructor Name (from Instructors)"].join(", ")
      : classDetails["Instructor Name (from Instructors)"];

    const instructorPicField = classDetails["Instructor Pic (from Instructors)"];
    const instructorPicUrl = instructorPicField && instructorPicField.length > 0 ? instructorPicField[0].url : "";

    const imagesField = classDetails["Images"];
    const imageUrls = imagesField && imagesField.length > 0 ? imagesField.map((image) => image.url) : [];

    const instructorDetails = classDetails["Instructor Details (from Instructors)"]?.[0] || "No details provided";
    const instructorCompany = classDetails["Instructor Company (from Instructors)"]?.[0] || "No company provided";

    for (const dropdownValue of ["Member", "Non-Member"]) {
      let memberValue = "No";
      let nonMemberValue = "No";
      let paymentLink = "";

      if (dropdownValue === "Member") {
        memberValue = "Yes";
        nonMemberValue = "No";
        paymentLink = stripeInfo.memberPaymentLink.url;
      } else if (dropdownValue === "Non-Member") {
        memberValue = "No";
        nonMemberValue = "Yes";
        paymentLink = stripeInfo.nonMemberPaymentLink.url;
      }
      const slug = generateSlug(classDetails, dropdownValue);

      // Prepare API request to Webflow
      const response = await axios.post(
        `https://api.webflow.com/v2/collections/${WEBFLOW_COLLECTION_ID}/items`,
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
            location: classDetails.Location,
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
            "non-member": nonMemberValue,
            "number-of-remaining-seats" : classDetails["Number of seats remaining"],
          },
        },
        {
          headers: {
            Authorization: `Bearer ${WEBFLOW_API_KEY}`,
            "Content-Type": "application/json",
          },
        }
      );

      console.log(`Successfully added ${dropdownValue} entry for class: ${classDetails.Name}`);
    }
  } catch (error) {
    if (error.response) {
      console.error("Webflow API Error:", error.response.data);
    } else {
      console.error("Unknown Error:", error.message);
    }
    throw error;
  }
}


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

    // Create a map of Webflow records by Airtable ID (supports multiple records per Airtable ID)
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

    // Iterate through Airtable records and sync with Webflow
    for (const airtableRecord of airtableRecords) {
      const airtableId = airtableRecord.id;
      const airtableSeatsRemaining = airtableRecord.fields["Number of seats remaining"];
      const numberOfSeats = airtableRecord.fields["Number of seats"]; // Getting the "Number of seats" value
    
      if (!airtableSeatsRemaining) {
        console.warn(`Airtable record ${airtableId} is missing the "Number of seats remaining" field.`);
        continue;
      }
    
      const webflowRecordsToUpdate = webflowRecordMap.get(airtableId);
    
      if (!webflowRecordsToUpdate || webflowRecordsToUpdate.length === 0) {
        console.log(`No matching Webflow records found for Airtable ID: ${airtableId}`);
        continue;
      }
    
      for (const webflowRecord of webflowRecordsToUpdate) {
        const webflowSeatsRemaining = webflowRecord.fieldData["number-of-remaining-seats"];
    
        // Check if there's a difference in seat counts
        if (String(webflowSeatsRemaining) !== String(airtableSeatsRemaining)) {
          console.log(
            `Difference detected for record with Airtable ID ${airtableId}: Airtable (${airtableSeatsRemaining}) vs Webflow (${webflowSeatsRemaining})`
          );
    
          // Update Webflow record
          try {
            const updateURL = `${webflowBaseURLs}/${webflowRecord.id}`;
            const updateData = {
              fieldData: {
                "number-of-remaining-seats": String(airtableSeatsRemaining),
                "number-of-seats": String(numberOfSeats), // Update with the "Number of seats" from Airtable
              },
            };
    
            const updateResponse = await axios.patch(updateURL, updateData, { headers: webflowHeaderss });
            console.log(`Updated fields in Webflow for Airtable ID ${airtableId}:`, updateResponse.data);
          } catch (updateError) {
            console.error(
              `Error updating Webflow record for Airtable ID ${airtableId}:`,
              updateError.response?.data || updateError.message
            );
          }
        } else {
          console.log(`No difference for record with Airtable ID ${airtableId} and Webflow record ID ${webflowRecord.id}.`);
        }
      }
    }
    
  } catch (airtableError) {
    console.error("Error fetching Airtable data:", airtableError.response?.data || airtableError.message);
  }
}

// Run the sync function
syncRemainingSeats();

// Run the sync function



async function runPeriodicallyw(intervalMs) {
  console.log("Starting periodic sync...");
  setInterval(async () => {
    console.log(`Running sync at ${new Date().toISOString()}`);
    await syncRemainingSeats();
  }, intervalMs);
}

runPeriodicallyw(30 * 1000);



// Update Airtable record with Stripe Product ID
async function updateAirtableRecord(recordId, stripeInfo) {
  try {
    // Validate recordId
    if (!recordId) {
      throw new Error("Invalid recordId: recordId is undefined or empty.");
    }

    // Log the inputs for debugging
    console.log("Record ID:", recordId);
    console.log("Stripe Info:", stripeInfo);

    // Perform the update
    await airtable.base(AIRTABLE_BASE_ID)(AIRTABLE_TABLE_NAME).update(recordId, {
      "Item Id": stripeInfo?.product?.id ?? "Unknown Product ID",
      "Member Price ID": String(stripeInfo?.memberPrice?.id ?? "Unknown Member Price ID"),
      "Non-Member Price ID": String(stripeInfo?.nonMemberPrice?.id ?? "Unknown Non-Member Price ID"),
    });

    console.log("Airtable record updated successfully!");
  } catch (error) {
    console.error("Error updating Airtable Record:", {
      recordId,
      stripeInfo,
      error: error.message,
    });
    throw error;
  }
}


// Main function to process new classes
async function processNewClasses() {
  const newClasses = await fetchNewClasses();

  for (const classDetails of newClasses) {
    try {
      console.log(`Processing class: ${classDetails.Name}`); // Log class name

      // Create Stripe product and prices
      const stripeInfo = await createStripeProducts(classDetails);

      // Add class to Webflow CMS
      await addToWebflowCMS(classDetails, stripeInfo);

      // Update Airtable with Stripe Product ID
      await updateAirtableRecord(classDetails.id, stripeInfo);

      console.log(`Successfully processed class: ${classDetails.Name}`);
    } catch (error) {
      logError(`Processing class: ${classDetails.Name}`, error);
    }
  }
}


const UNIQUE_SITE_ID = "670d37b3620fd9656047ce2d";
const UNIQUE_API_BASE_URL = "https://api.webflow.com/v2";

// Publish staged items of "Classes"
async function publishUniqueClasses() {
  try {
    // Fetch all collections for the site
    const uniqueCollectionsResponse = await axios.get(`${UNIQUE_API_BASE_URL}/sites/${UNIQUE_SITE_ID}/collections`, {
      headers: {
        Authorization: `Bearer ${WEBFLOW_API_KEY}`,
        "Accept-Version": "1.0.0",
      },
    });

    const uniqueCollections = uniqueCollectionsResponse.data.collections || [];
    if (!uniqueCollections.length) {
      console.log("No collections available for this site.");
      return;
    }

    console.log(
      "Discovered Collections:",
      uniqueCollections.map((collection) => ({
        uniqueId: collection.id,
        uniqueName: collection.displayName,
        uniqueSlug: collection.slug,
      }))
    );

    const classesCollection = uniqueCollections.find(
      (collection) => collection.displayName === "Classes"
    );

    if (!classesCollection) {
      console.log("The 'Classes' collection was not found. Please verify the collection name.");
      return;
    }

    const UNIQUE_CLASSES_COLLECTION_ID = classesCollection.id;
    console.log(`Identified Classes Collection ID: ${UNIQUE_CLASSES_COLLECTION_ID}`);

    // Fetch items within the 'Classes' collection
    const uniqueItemsResponse = await axios.get(`${UNIQUE_API_BASE_URL}/collections/${UNIQUE_CLASSES_COLLECTION_ID}/items`, {
      headers: {
        Authorization: `Bearer ${WEBFLOW_API_KEY}`,
        "Accept-Version": "1.0.0",
      },
    });

    const classItems = uniqueItemsResponse.data.items || [];

    // Identify items that need publishing
    const uniqueClassItemIds = classItems
      .filter((item) => {
        return item.lastPublished === null || new Date(item.lastUpdated) > new Date(item.lastPublished);
      })
      .map((item) => item.id);

    if (!uniqueClassItemIds.length) {
      console.log("No unpublished or updated items found in the 'Classes' collection.");
      return;
    }

    console.log(`Items eligible for publishing: ${uniqueClassItemIds}`);

    // Publish the items
    const uniquePublishResponse = await axios.post(
      `${UNIQUE_API_BASE_URL}/collections/${UNIQUE_CLASSES_COLLECTION_ID}/items/publish`,
      { itemIds: uniqueClassItemIds },
      {
        headers: {
          Authorization: `Bearer ${WEBFLOW_API_KEY}`,
          "Content-Type": "application/json",
        },
      }
    );

    console.log("Publishing Response for 'Classes':", uniquePublishResponse.data);
  } catch (error) {
    console.error("An error occurred while publishing 'Classes' items:", error.response?.data || error.message);
  }
}

// Periodic runner for "Classes"
async function periodicUniqueClassSync(intervalMs) {
  console.log("Starting unique class sync process...");
  setInterval(async () => {
    console.log(`Executing sync for 'Classes' at ${new Date().toISOString()}`);
    await publishUniqueClasses();
  }, intervalMs);
}

// Run periodic sync for "Classes" every 30 seconds
periodicUniqueClassSync(30 * 1000);


// Airtable setup
const base = new Airtable({ apiKey: AIRTABLE_API_KEY }).base(AIRTABLE_BASE_ID);

app.post('/waitlist', async (req, res) => {
  const { loginDetails, classId, loginMember, className, instructor ,classur } = req.body;

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
          'Class Airtable ID':classId,
          'Class Airtables ID': [classRecordId], // Link to the related class
          'Class URL':classur,
        },
      },
    ]);

    res.status(201).json({ message: 'Record created successfully.', record: newRecord });
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

    // Calculate the total payment dynamically
    const totalPayment = numberOfSeats * parseFloat(fields.pricePerSeat || 0);
    if (totalPayment <= 0) {
      return res.status(400).send({ message: 'Invalid total payment amount.' });
    }

    // Initialize variables for Airtable records
    const seatRecords = [];
    const seatRecordIds = [];
    const registeredNames = [];
    let seatCount = 0;
    let biawClassId = null; 

    for (let i = 1; i <= 10; i++) {
      const name = fields[`P${i}-Name`];
      const email = fields[`P${i}-Email`];
      const phone = fields[`P${i}-Phone-number`] || fields[`P${i}-Phone-Number`];
      const airID = fields['airtable-id']; 

      if (!name && !email && !phone) {
        continue;
      }

      if (name) {
        seatCount++;
      }

      // Fetch class from Airtable using the `airID` (only fetch once)
      if (!biawClassId) {
        const biawClassesTables = await airtable.base(AIRTABLE_BASE_ID)("Biaw Classes")
          .select({
            filterByFormula: `{Field ID} = '${airID}'`,
            maxRecords: 1,
          })
          .firstPage();

        if (biawClassesTables.length === 0) {
          console.error("No matching record found in Biaw Classes table");
          return res.status(500).send({ message: "No matching class found for the provided Airtable ID." });
        }

        const biawClassRecord = biawClassesTables[0];
        biawClassId = biawClassRecord.id;
        console.log('Fetched Biaw Class ID:', biawClassId); 
      }

      // Create seat record
      const seatRecord = {
        "Name": name || "",
        "Email": email || "",
        "Phone Number": phone || "",
        "Time Stamp": timestampField,
        "Purchased class Airtable ID": airID,
        "Payment Status": "Pending",
        "Biaw Classes": [biawClassId], 
      };

      seatRecords.push(seatRecord);
    }

    // Create seat records in Airtable
    const createdRecords = [];
    for (const record of seatRecords) {
      const createdRecord = await airtable
        .base(AIRTABLE_BASE_ID)(AIRTABLE_TABLE_NAME2)
        .create(record);

      createdRecords.push(createdRecord);
      seatRecordIds.push(createdRecord.id); 
      registeredNames.push(record["Name"]);
    }

    // Create payment record in Airtable
    const paymentRecord = {
      "Name": SignedMemberName,
      "Email": signedmemberemail,
      "Client ID": fields['field-2'],
      "Airtable id": fields['airtable-id'],
      "Client name": SignedMemberName,
      "Payment Status": "Pending",
      "Biaw Classes": [biawClassId], 
      "Multiple Class Registration": seatRecordIds,
      "Number of seat Purchased": seatCount,
      "Booking Type": "User booked",
      "ROII member": "No",
      "Purchased Class url": fields['class-url']
    };

    let paymentCreatedRecord;
    try {
      paymentCreatedRecord = await airtable
        .base(AIRTABLE_BASE_ID)("Payment Records")
        .create(paymentRecord);

      console.log('Payment record created:', paymentCreatedRecord); 
    } catch (paymentError) {
      console.error("Error adding to Payment Records:", paymentError);
      return res.status(500).send({ message: "Error registering payment record", error: paymentError });
    }

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


//ROII REGISTRATION

app.post('/register-class', async (req, res) => {
  const { memberid, timestampField, ...fields } = req.body;

  try {
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
        "Payment Status":"ROII Free"
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
      "Client ID": memberid,
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

      console.log(`Retrieved Biaw Classes details:`, biawClassesDetails);

      const webflowData = {
        fieldData: {
          name: biawClassesDetails[0]?.Name || "",
          _archived: false,
          _draft: false,
          "field-id": record.fields["Airtable id"],
          "member-id": record.fields["Client ID"],
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
          "class-url": record.fields["Purchased Class url"] || ""
        },
      };

      // Check if the record already exists in Webflow
      if (webflowRecordIds.has(airtableRecordId)) {
        const webflowRecord = existingWebflowRecords.find(r => r.fieldData["purchase-record-airtable-id"] === airtableRecordId);

        const fieldsToUpdate = {};
        let needsUpdate = false;

        for (const field in webflowData.fieldData) {
          if (field === "banner-image") continue;

          const webflowFieldValue = String(webflowRecord.fieldData[field] || "").trim();
          const airtableFieldValue = String(webflowData.fieldData[field] || "").trim();

          if (webflowFieldValue !== airtableFieldValue) {
            needsUpdate = true;
            fieldsToUpdate[field] = webflowData.fieldData[field];
          }
        }

        if (needsUpdate) {
          console.log(`Record with Airtable ID ${airtableRecordId} has changes. Updating the following fields: ${Object.keys(fieldsToUpdate).join(", ")}`);
          try {
            const updateURL = `${webflowBaseURL}/${webflowRecord.id}`;
            await axios.patch(updateURL, { fieldData: fieldsToUpdate }, { headers: webflowHeaders });
            console.log(`Successfully updated record in Webflow.`);
          } catch (webflowError) {
            console.error(`Error updating record in Webflow:`, webflowError.response?.data || webflowError.message);
          }
        } else {
          console.log(`Record with Airtable ID ${airtableRecordId} is up to date in Webflow. No update needed.`);
        }
      } else {
        try {
          await axios.post(webflowBaseURL, webflowData, { headers: webflowHeaders });
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



const SITE_ID = "670d37b3620fd9656047ce2d";
const API_BASE_URL = "https://api.webflow.com/v2";

// Publish staged items of purchases
async function publishStagedItems() {
  try {
    // Fetch all collections for the site
    const collectionsResponse = await axios.get(`${API_BASE_URL}/sites/${SITE_ID}/collections`, {
      headers: {
        Authorization: `Bearer ${WEBFLOW_API_KEY}`,
        "Accept-Version": "1.0.0",
      },
    });

    const collections = collectionsResponse.data.collections || [];
    if (!collections.length) {
      console.log("No collections found.");
      return;
    }

    console.log(
      "Available Collections:",
      collections.map((col) => ({
        id: col.id,
        name: col.displayName,
        slug: col.slug,
      }))
    );

    const targetCollection = collections.find(
      (collection) => collection.displayName === "Purchases"
    );

    if (!targetCollection) {
      console.log("Target collection not found. Ensure the collection name matches exactly.");
      return;
    }

    const COLLECTION_ID = targetCollection.id;
    console.log(`Using Collection ID: ${COLLECTION_ID}`);

    // Fetch items in the collection
    const itemsResponse = await axios.get(`${API_BASE_URL}/collections/${COLLECTION_ID}/items`, {
      headers: {
        Authorization: `Bearer ${WEBFLOW_API_KEY}`,
        "Accept-Version": "1.0.0",
      },
    });

    const items = itemsResponse.data.items || [];

    // Filter out items where 'lastPublished' is null or if they have been updated since last publication
    const stagedItemIds = items
      .filter((item) => {
        // If the item has not been published yet or has been updated since its last publish
        return item.lastPublished === null || new Date(item.lastUpdated) > new Date(item.lastPublished);
      })
      .map((item) => item.id);

    if (!stagedItemIds.length) {
      console.log("No items to publish.");
      return;
    }

    console.log(`Items ready for publishing: ${stagedItemIds}`);

    // Publish the items
    const publishResponse = await axios.post(
      `${API_BASE_URL}/collections/${COLLECTION_ID}/items/publish`,
      { itemIds: stagedItemIds },
      {
        headers: {
          Authorization: `Bearer ${WEBFLOW_API_KEY}`,
          "Content-Type": "application/json",
        },
      }
    );

    console.log("Publish Response:", publishResponse.data);
  } catch (error) {
    console.error("Error publishing staged items:", error.response?.data || error.message);
  }
}

publishStagedItems();


async function runPeriodicallys(intervalMs) {
  console.log("Starting periodic sync...");
  setInterval(async () => {
    console.log(`Running sync at ${new Date().toISOString()}`);
    await publishStagedItems();
  }, intervalMs);
}

runPeriodicallys(30 * 1000);




//Main function to process new classes periodically
async function processNewClassesPeriodically() {
  try {
    console.log("Starting periodic class processing...");

    await processNewClasses();

    setInterval(async () => {
      try {
        console.log("Checking for new classes...");
        await processNewClasses();
        console.log("Periodic check completed.");
      } catch (error) {
        logError("Periodic Class Processing", error);
      }
    }, 30 * 1000);
  } catch (error) {
    logError("Initial Process", error);
  }
}

// Start the periodic process
processNewClassesPeriodically();


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

    const currentPaymentStatus = recordResponse.data.fields["Payment Status"];
    const seatCount = recordResponse.data.fields["Number of seat Purchased"];
    const classID = recordResponse.data.fields["Biaw Classes"][0];
    const multipleClassRegistrationIds = recordResponse.data.fields["Multiple Class Registration"] || []; // Linked record IDs

    // Determine the new payment status
    let newPaymentStatus = "Refunded";
    if (currentPaymentStatus === "ROII-Free") {
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
    if (paymentIntentId) {
      const refund = await stripe3.refunds.create({
        payment_intent: paymentIntentId,
      });

      console.log("Refund successful:", refund);
      refundId = refund.id;
    }

    res.status(200).json({
      message: "Payment status updated, class seat adjusted, and refund processed.",
      recordId: airtableRecordId,
      refundId: refundId || "No refund needed",
    });

  } catch (error) {
    console.error("Error processing the payment cancellation and refund:", error.message);
    res.status(500).json({ message: "Failed to process refund and update records", error: error.message });
  }
});


(async () => {
  try {
    console.log("Starting class processing...");
    await processNewClasses();
    console.log("Class processing completed.");
  } catch (error) {
    logError("Main Process", error);
  }
})();


const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});


