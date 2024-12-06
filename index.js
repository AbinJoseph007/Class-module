const Airtable = require('airtable');
const Stripe = require('stripe');
const express = require('express');
const cors = require("cors");
const axios = require('axios');
require('dotenv').config();

const app = express();
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

// Initialize services
const airtable = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY });
const stripe = new Stripe(process.env.STRIPE_API_KEY);

// Configurations
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
const AIRTABLE_TABLE_NAME = process.env.AIRTABLE_TABLE_NAME;
const WEBFLOW_API_KEY = process.env.WEBFLOW_API_KEY;
const WEBFLOW_COLLECTION_ID = process.env.WEBFLOW_COLLECTION_ID;
const AIRTABLE_TABLE_NAME2 = process.env.AIRTABLE_TABLE_NAME2
const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY

// Helper function for logging errors
function logError(context, error) {
  console.error(`[ERROR] ${context}:`, error.message || error);
}

// Helper function to parse price values
const parsePrice = (price) => {
  try {
    // Check if the price is a number
    if (typeof price === "number") {
      return price;
    }

    // If it's a string, clean and parse it
    if (typeof price === "string") {
      const cleanedPrice = price.replace(/[$,]/g, ''); // Remove $ and commas
      const parsedPrice = parseFloat(cleanedPrice);
      if (isNaN(parsedPrice)) {
        throw new Error(`Invalid price value: ${price}`);
      }
      return parsedPrice;
    }

    

    // If the price is neither a number nor a string, throw an error
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
      .select({ filterByFormula: "NOT({Item Id})" }) // Fetch only new records
      .all();
    console.log("Fetched new records from Airtable:", records.map((rec) => rec.fields));
    return records.map((record) => ({ id: record.id, ...record.fields}));
  } catch (error) {
    logError("Fetching Airtable Records", error);
    return [];
  }
}

// Create a product and prices in Stripe
async function createStripeProduct(classDetails) {
  try {
    // Log raw price values for debugging
    console.log("Raw Member Price:", classDetails["Price - Member"]);
    console.log("Raw Non-Member Price:", classDetails["Price - Non Member"]);

    // Parse and validate prices
    const memberPriceAmount = parsePrice(classDetails["Price - Member"]);
    const nonMemberPriceAmount = parsePrice(classDetails["Price - Non Member"]);

    // Create product on Stripe
    const product = await stripe.products.create({
      name: classDetails.Name, // "Name" from Airtable
      description: classDetails.Description || "No description provided",
    });

    // Create member price on Stripe
    const memberPrice = await stripe.prices.create({
      unit_amount: Math.round(memberPriceAmount * 100), // Convert to cents
      currency: 'usd',
      product: product.id,
    });

    // Create non-member price on Stripe
    const nonMemberPrice = await stripe.prices.create({
      unit_amount: Math.round(nonMemberPriceAmount * 100), // Convert to cents
      currency: 'usd',
      product: product.id,
    });

    // Generate a payment link using the Stripe Payment Links API
    const paymentLink = await stripe.paymentLinks.create({
      line_items: [
        { price: memberPrice.id, quantity: 1 },
        { price: nonMemberPrice.id, quantity: 1 },
      ],
    });

    return { product, memberPrice, nonMemberPrice ,paymentLink };
  } catch (error) {
    logError("Creating Stripe Product", error);
    throw error;
  }
}

// Clean the slug by removing any non-alphabetic characters and keeping only letters and spaces
function generateSlug(classDetails, dropdownValue) {
  const cleanedName = classDetails.Name
    .replace(/[^a-zA-Z\s]/g, '') // Remove anything that isn't a letter or space
    .toLowerCase()               // Convert to lowercase
    .replace(/\s+/g, '-')         // Replace spaces with hyphens

  const cleanedDropdownValue = dropdownValue.toLowerCase().replace(/\s+/g, '-');

  return `${cleanedName}-${cleanedDropdownValue}`;
}


async function addToWebflowCMS(classDetails, stripeInfo) {
  try {
    // Extract instructor name
    const instructorName = Array.isArray(classDetails["Instructor Name (from Instructors)"])
      ? classDetails["Instructor Name (from Instructors)"].join(", ")
      : classDetails["Instructor Name (from Instructors)"];

    // Extract instructor pic URL
    const instructorPicField = classDetails["Instructor Pic (from Instructors)"];
    const instructorPicUrl = instructorPicField && instructorPicField.length > 0 ? instructorPicField[0].url : "";

    // Extract multiple image URLs
    const imagesField = classDetails["Images"];
    const imageUrls = imagesField && imagesField.length > 0 ? imagesField.map((image) => image.url) : [];

    // Extract additional instructor details
    const instructorDetails = classDetails["Instructor Details (from Instructors)"]?.[0] || "No details provided";
    const instructorCompany = classDetails["Instructor Company (from Instructors)"]?.[0] || "No company provided";

    const paymentLink = stripeInfo.paymentLink.url; // Use the dynamic payment link from Stripe

    // Loop for creating two entries for "Member" and "Non-Member"
    for (const dropdownValue of ["Member", "Non-Member"]) {
      // Determine the values for "member" and "non-member"
      let memberValue = "No";
      let nonMemberValue = "No";

      if (dropdownValue === "Member") {
        memberValue = "Yes";
        nonMemberValue = "No";
      } else if (dropdownValue === "Non-Member") {
        memberValue = "No";
        nonMemberValue = "Yes";
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
            "item-id": String(stripeInfo.product.id),
            "price-member": String(classDetails["Price - Member"]) ,
            "price-non-member": String(classDetails["Price - Non Member"]),
            "member-price-id":  String(stripeInfo.memberPrice.id) ,
            "non-member-price-id": String(stripeInfo.nonMemberPrice.id) ,
            "field-id": String(classDetails["Field ID"]),
            date: classDetails.Date,
            "end-date": classDetails["End date"],
            location: classDetails.Location,
            "start-time": classDetails["Start Time"],
            "end-time": classDetails["End Time"],
            "class-type": classDetails["Product Type"],
            "instructor-name": instructorName,
            "instructor-pic": instructorPicUrl,
            "image-2": imageUrls,
            "main-images": imageUrls,
            "instructor-details": instructorDetails,
            "instructor-company": instructorCompany,
            "payment-link": paymentLink,
            "price-roii-participants": classDetails["Price - ROII Participants (Select)"],
            "created-date": classDetails.Created,
            "number-of-seats": String(classDetails["Number of seats"]),
            "airtablerecordid": classDetails.id,
            "member-non-member": dropdownValue, // Add the dropdown field value ("Member" or "Non-Member")
            "member": memberValue, // Set member value based on dropdown
            "non-member": nonMemberValue, // Set non-member value based on dropdown
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




// Update Airtable record with Stripe Product ID
async function updateAirtableRecord(recordId, stripeInfo) {
  try {
    await airtable.base(AIRTABLE_BASE_ID)(AIRTABLE_TABLE_NAME).update(recordId, {
      "Item Id": stripeInfo.product.id, // Maps to "Item Id" in Airtable
    });
  } catch (error) {
    logError("Updating Airtable Record", error);
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
      const stripeInfo = await createStripeProduct(classDetails);

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

app.post('/submit-class', async (req, res) => {
  const { SignedMemberName, signedmemberemail,timestampField,  clientID, ...fields } = req.body;

  try {
    const seatRecords = []; // Array to hold the seat records

    // Loop through the submitted fields dynamically
    for (let i = 1; i <= 10; i++) { // Assuming max 10 seats
      const name = fields[`P${i}-Name`];
      const email = fields[`P${i}-Email`];
      const phone = fields[`P${i}-Phone-number`];
      const airID =fields['airtable-id'];

      // Skip empty seat data
      if (!name && !email && !phone) {
        continue;
      }

      // Prepare a record for Airtable
      seatRecords.push({
        "Name": name || "", // Default to empty string if field is missing
        "Email": email || "",
        "Phone Number":phone,
        "Time Stamp":timestampField,
        "Purchased class Airtable ID": airID,
        "Payment Status": "Pending",
      });
    }

    // Send each seat record to Airtable
    const createdRecords = [];
    for (const record of seatRecords) {
      const createdRecord = await airtable
        .base(AIRTABLE_BASE_ID)(AIRTABLE_TABLE_NAME2)
        .create(record);
      createdRecords.push(createdRecord);
    }

    res.status(200).send({ message: "Class registered successfully", records: createdRecords });
  } catch (error) {
    console.error("Error adding records to Airtable", error);
    res.status(500).send({ message: "Error registering class" });
  }
});

syncAirtableToWebflow();
// Run the script
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


