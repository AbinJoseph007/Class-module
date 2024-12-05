const Airtable = require('airtable');
const Stripe = require('stripe');
const axios = require('axios');
require('dotenv').config();

// Initialize services
const airtable = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY });
const stripe = new Stripe(process.env.STRIPE_API_KEY);

// Configurations
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
const AIRTABLE_TABLE_NAME = process.env.AIRTABLE_TABLE_NAME;
const WEBFLOW_API_KEY = process.env.WEBFLOW_API_KEY;
const WEBFLOW_COLLECTION_ID = process.env.WEBFLOW_COLLECTION_ID;

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
    const imagesField = classDetails["Images"]; // Replace with Airtable field for images
    const imageUrls = imagesField && imagesField.length > 0 ? imagesField.map((image) => image.url) : [];

    // Extract additional instructor details
    const instructorDetails = classDetails["Instructor Details (from Instructors)"]?.[0] || "No details provided";
    const instructorCompany = classDetails["Instructor Company (from Instructors)"]?.[0] || "No company provided";

    const paymentLink = stripeInfo.paymentLink.url; // Use the dynamic payment link from Stripe


    // Prepare API request to Webflow
    const response = await axios.post(
      `https://api.webflow.com/v2/collections/${WEBFLOW_COLLECTION_ID}/items`,
      {
        fieldData: {
          name: classDetails.Name,
          slug: classDetails.Name.toLowerCase().replace(/\s+/g, '-'),
          description: classDetails.Description || "No description available",
          "item-id": String(stripeInfo.product.id), // Ensure this is a string
          "price-member": String(classDetails["Price - Member"]), // Convert to string
          "price-non-member": String(classDetails["Price - Non Member"]), // Convert to string
          "member-price-id": String(stripeInfo.memberPrice.id), // Convert to string
          "non-member-price-id": String(stripeInfo.nonMemberPrice.id), // Convert to string
          "field-id": String(classDetails["Field ID"]), // Convert to string
          date: classDetails.Date,
          "end-date": classDetails["End date"],
          location: classDetails.Location,
          "start-time": classDetails["Start Time"],
          "end-time": classDetails["End Time"],
          "class-type": classDetails["Product Type"],
          "instructor-name": instructorName,
          "instructor-pic": instructorPicUrl,
          "image-2": imageUrls, // Array of image URLs
          "instructor-details": instructorDetails,
          "instructor-company": instructorCompany,
          "payment-link":paymentLink,
          "price-roii-participants":classDetails["Price - ROII Participants (Select)"],
          "created-date":classDetails.Created,
          "number-of-seats":String(classDetails["Number of seats"]),
          "airtablerecordid": classDetails.id,
         },
      },
      {
        headers: {
          Authorization: `Bearer ${WEBFLOW_API_KEY}`,
          "Content-Type": "application/json",
        },
      }
    );

    // Return Webflow API response
    return response.data;
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
