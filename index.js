const Airtable = require('airtable');
const Stripe = require('stripe');
const express = require('express');
const cors = require("cors");
const axios = require('axios');
const cron = require('node-cron');
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

    const memberPaymentLink = await stripe.paymentLinks.create({
      line_items: [{ price: memberPrice.id, quantity: 1 }],
    });

    const nonMemberPaymentLink = await stripe.paymentLinks.create({
      line_items: [{ price: nonMemberPrice.id, quantity: 1 }],
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
            "member-price-id": String(stripeInfo.memberPrice.id),
            "non-member-price-id": String(stripeInfo.nonMemberPrice.id),
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

// async function getAirtableClassRecords() {
//   const url = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${AIRTABLE_TABLE_NAME}`;
//   console.log('Fetching Airtable records from:', url);

//   const response = await fetch(url, {
//     headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}` },
//   });

//   if (!response.ok) {
//     console.error('Failed to fetch Airtable records:', response.status, response.statusText);
//     return [];
//   }

//   const data = await response.json();
//   console.log('Received Airtable records:', data.records);
//   return data.records;
// }

// // Fetch records from Webflow
// async function getWebflowRecords() {
//   const url = `https://api.webflow.com/v2/collections/${WEBFLOW_COLLECTION_ID}/items`;
//   console.log('Fetching Webflow records from:', url);

//   const response = await fetch(url, {
//     headers: {
//       Authorization: `Bearer ${WEBFLOW_API_KEY}`,
//       'accept-version': '1.0.0',
//     },
//   });

//   if (!response.ok) {
//     console.error('Failed to fetch Webflow records:', response.status, response.statusText);
//     return [];
//   }

//   const data = await response.json();
//   console.log('Received Webflow records:', data.items);
//   return data.items;
// }

// // Check for differences between Airtable and Webflow fields
// function hasDifferences(airtableFields, webflowFields ) {
//   return (
//     airtableFields.Name !== webflowFields.name ||
//     airtableFields.Description !== webflowFields.description ||
//     airtableFields.Date !== webflowFields.date ||
//     airtableFields['End date'] !== webflowFields['end-date'] ||
//     airtableFields.Location !== webflowFields.location ||
//     airtableFields['Start time'] !== webflowFields['start-time'] ||
//     airtableFields['End Time'] !== webflowFields['end-time'] ||
//     (airtableFields.InstructorNames.join(', ') || 'Instructor Unavailable') !== webflowFields['instructor-name'] ||
//     airtableFields['Product Type'] !== webflowFields['class-type'] ||
//     String(airtableFields['Number of seats']) !== String(webflowFields['number-of-seats']) ||
//     airtableFields['Price - Member'] !== Number(webflowFields['price-member']) ||
//     airtableFields['Price - Non Member'] !== Number(webflowFields['price-non-member'])
//   );
// }



// // Synchronize Airtable to Webflow
// async function syncAirtableToWebflow() {
//   const airtableRecords = await getAirtableClassRecords();
//   const webflowRecords = await getWebflowRecords();

//   const webflowItemMap = webflowRecords.reduce((map, item) => {
//     map[item.fieldData.airtablerecordid] = item;
//     return map;
//   }, {});

//   const airtableRecordIds = new Set(airtableRecords.map(record => record.id));

//   // Delete Webflow items not in Airtable
//   for (const webflowItem of webflowRecords) {
//     if (!airtableRecordIds.has(webflowItem.fieldData.airtablerecordid)) {
//       await deleteWebflowItem(webflowItem.id);
//     }
//   }

//   // Update or add items in Webflow
//   for (const record of airtableRecords) {
//     const fields = {
//       Name: record.fields.Name || '',
//       Description: record.fields.Description || '',
//       Date: record.fields.Date || '',
//       'End date': record.fields['End date'] || '',
//       Location: record.fields.Location || '',
//       'Number of seats': record.fields['Number of seats'] || '0',
//       'Price - Member': record.fields['Price - Member'] || '0',
//       'Price - Non Member': record.fields['Price - Non Member'] || '0',
//       airtablerecordid: record.id,
//     };

//     const webflowItem = webflowItemMap[record.id];
//     if (webflowItem) {
//       if (hasDifferences(fields, webflowItem.fieldData)) {
//         await updateWebflowItem(webflowItem.id, fields);
//       }
//     } else {
//       await addToWebflowCMS(fields);
//     }
//   }
// }

// async function updateWebflowItem(webflowId, fieldsToUpdate) {
//   const url = `https://api.webflow.com/collections/${WEBFLOW_COLLECTION_ID}/items/${webflowId}`;
//   console.log('Updating Webflow item:', webflowId);

//   // Structure the fieldData based on the Webflow collection's field names
//   const fieldData = {
//     fieldData: {
//       name: fieldsToUpdate.Name,
//       description: fieldsToUpdate.Description,
//       date: fieldsToUpdate.Date,
//       "end-date": fieldsToUpdate["End date"],
//       location: fieldsToUpdate.Location,
//       "start-time": fieldsToUpdate["Start Time"],
//       "end-time": fieldsToUpdate["End Time"],
//       "class-type": fieldsToUpdate["Product Type"],
//       "price-member": fieldsToUpdate["Price - Member"],
//       "price-non-member": fieldsToUpdate["Price - Non Member"],
//       "number-of-seats": fieldsToUpdate["Number of seats"],
//       "airtablerecordid": fieldsToUpdate.airtablerecordid,
//     }
//   };

//   try {
//     const response = await axios.put(
//       url,
//       fieldData,
//       {
//         headers: {
//           Authorization: `Bearer ${WEBFLOW_API_KEY}`,
//           'Content-Type': 'application/json',
//         }
//       }
//     );

//     if (response.status === 200) {
//       console.log(`Successfully updated Webflow item: ${webflowId}`);
//     } else {
//       console.error(`Failed to update Webflow item: ${webflowId}`, response.data);
//     }
//   } catch (error) {
//     if (error.response) {
//       console.error("Error response from Webflow:", error.response.data);
//     } else {
//       console.error("Error updating Webflow item:", error.message);
//     }
//     throw error;
//   }
// }



// // Delete Webflow item
// async function deleteWebflowItem(webflowId) {
//   const url = `https://api.webflow.com/v2/collections/${WEBFLOW_COLLECTION_ID}/items/${webflowId}`;
//   console.log('Deleting Webflow item:', webflowId);

//   try {
//     const response = await fetch(url, {
//       method: 'DELETE',
//       headers: { Authorization: `Bearer ${WEBFLOW_API_KEY}` },
//     });

//     if (!response.ok) {
//       console.error('Failed to delete Webflow item:', await response.json());
//       return false;
//     }

//     console.log('Deleted Webflow item:', webflowId);
//     return true;
//   } catch (error) {
//     console.error('Error deleting Webflow item:', error);
//     return false;
//   }
// }



// // Execute synchronization
// syncAirtableToWebflow();





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

//class registration form submission

app.post('/submit-class', async (req, res) => {
  const { SignedMemberName, signedmemberemail, timestampField, ...fields } = req.body;

  try {
    const seatRecords = [];
    const seatRecordIds = [];
    const registeredNames = [];
    let seatCount = 0;


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
        "Name": name || "",
        "Email": email || "",
        "Phone Number": phone || "",
        "Time Stamp": timestampField,
        "Purchased class Airtable ID": airID,
        "Payment Status": "Pending",
        "Biaw Classes": [biawClassIds],

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


    const paymentRecord = {
      "Name": SignedMemberName,
      "Email": signedmemberemail,
      "Client ID": fields['field-2'],
      "Airtable id": fields['airtable-id'],
      "Client name": SignedMemberName,
      "Payment Status": "Pending",
      "Biaw Classes": [fields['airtable-id']],
      "Multiple Class Registration": seatRecordIds,
      "Number of seat Purchased": seatCount,
      "Biaw Classes": [biawClassId],
      "Booking Type": "User booked",
      "ROII member": "No"
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


//ROII REGISTRATION

app.post('/register-class', async (req, res) => {
  const { memberid, timestampField, ...fields } = req.body;

  try {
    const seatRecords = [];
    const seatRecordIds = [];
    const registeredNames = [];
    let seatCount = 0;

    // Loop through the submitted fields dynamically
    for (let i = 1; i <= 10; i++) { // Assuming max 10 seats
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
      "ROII member": "Yes"

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

// payment updation
const stripes = Stripe(process.env.STRIPE_API_KEY);

const airtableBase = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(process.env.AIRTABLE_BASE_ID); // Correct initialization

const generateStripeLikeId = () => {
  const prefix = "cs_test_";
  const randomString = Array.from({ length: 56 }, () => {
    const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    return chars.charAt(Math.floor(Math.random() * chars.length));
  }).join("");
  return `${prefix}${randomString}`;
};

const checkAndPushPayments = async () => {
  try {
    console.log('Checking for the latest payment...');

    // Fetch the most recent charge from Stripe
    const charges = await stripes.charges.list({ limit: 1 });
    const latestCharge = charges.data[0];

    if (!latestCharge) {
      console.log('No new payments found');
      return;
    }

    const paymentId = latestCharge.id;
    const amountTotal = latestCharge.amount / 100;
    const paymentStatus = latestCharge.status;
    const paymentIntentId = latestCharge.payment_intent; // Unique ID from Stripe
    const email = latestCharge.billing_details?.email || null;
    const paymentTimestamp = latestCharge.created * 1000; // Stripe uses Unix timestamp (seconds), convert to milliseconds
    const currentTimestamp = Date.now();

    // Log payment details
    console.log('Latest payment details:', { paymentId, paymentIntentId, amountTotal, paymentStatus, email, paymentTimestamp });

    // Check if the payment was made more than one minute ago
    if (currentTimestamp - paymentTimestamp > 20000) {
      console.log('Payment is older than twemty seconds. Skipping push to Airtable.');
      return;
    }

    if (!email) {
      console.log('No email found in Stripe payment details');
      return;
    }

    // Ensure the payment is successful before proceeding
    if (paymentStatus !== 'succeeded') {
      console.log('Payment not successful. Skipping Airtable update.');
      return;
    }

    // Query Airtable for all records matching the email
    const matchingRecords = await airtableBase(AIRTABLE_TABLE_NAME3)
      .select({
        filterByFormula: `{Email} = '${email}'`,
        sort: [{ field: "Created", direction: "asc" }], // Sort in ascending order to identify the last row
      })
      .all(); // Fetch all records

    if (matchingRecords.length === 0) {
      console.log('No matching email found in Airtable.');
      return;
    }

    // Target only the last record in the Airtable results
    const lastRecord = matchingRecords[matchingRecords.length - 1]; // Bottom row

    const newPaymentId = generateStripeLikeId();

    const updatedFields = {
      "Payment ID": paymentId,
      "Amount Total": new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'USD',
      }).format(amountTotal),
      "Payment Status": "Paid", // Update to "Paid"
    };

    console.log(`Updating the last record with ID ${lastRecord.id} in Airtable:`, updatedFields);
    await airtableBase(AIRTABLE_TABLE_NAME3).update(lastRecord.id, updatedFields);
    console.log(`Last record with ID ${lastRecord.id} successfully updated.`);
  } catch (error) {
    console.error('Error in checkAndPushPayments:', error);
  }
};


cron.schedule('*/20 * * * * *', async () => {
  console.log('Running scheduled job: Checking for new payments...');
  await checkAndPushPayments();
});

app.get('/latest-payment', async (req, res) => {
  try {
    console.log('Manual request: Checking for new payments...');
    await checkAndPushPayments();
    res.status(200).json({ message: 'Payment check completed' });
  } catch (error) {
    console.error('Error in /latest-payment route:', error);
    res.status(500).json({ message: 'Error processing payment', error });
  }
});

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

      // Skip records with "Payment Status" as "Pending"
      if (record.fields["Payment Status"] === "Pending") {
        console.log(`Skipping record with Airtable ID ${airtableRecordId} due to Pending Payment Status.`);
        continue;
      }

      // Check if the record already exists in Webflow
      if (webflowRecordIds.has(airtableRecordId)) {
        const webflowRecord = existingWebflowRecords.find(r => r.fieldData["purchase-record-airtable-id"] === airtableRecordId);

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

        // Prepare the new data to be sent to Webflow
        const webflowData = {
          fieldData: {
            name: biawClassesDetails[0]?.Name || "",
            _archived: false,
            _draft: false,
            "field-id": record.fields["Airtable id"],
            "member-id": record.fields["Client ID"],
            "mail-id": record.fields["Email"],
            "total-amount": String(record.fields["Amount Total"]),
            "purchase-class-name": biawClassesDetails[0]?.Name || "",
            "purchased-class-end-date": biawClassesDetails[0]?.["End date"] || "",
            "purchased-class-end-time": biawClassesDetails[0]?.["End Time"] || "",
            "purchased-class-start-date": biawClassesDetails[0]?.Date || "",
            "purchased-class-start-time": biawClassesDetails[0]?.["Start Time"] || "",
            "payment-status": record.fields["Payment Status"],
            "image": biawClassesDetails[0]?.Images?.[0]?.url || "",
            "number-of-purchased-seats": String(record.fields["Number of seat Purchased"]),
            "purchase-record-airtable-id": airtableRecordId,
            "payment-intent-2": record.fields["Payment ID"]
          },
        };

        // Compare fields one by one to track changes
        const fieldsToUpdate = {};
        let needsUpdate = false;

        for (const field in webflowData.fieldData) {
          const webflowFieldValue = String(webflowRecord.fieldData[field] || '').trim(); // Ensure values are strings and trimmed
          const airtableFieldValue = String(webflowData.fieldData[field] || '').trim(); // Ensure values are strings and trimmed

          if (webflowFieldValue !== airtableFieldValue) {
            needsUpdate = true;
            fieldsToUpdate[field] = webflowData.fieldData[field];
          }
        }

        // Only send an update if there are changed fields
        if (needsUpdate) {
          console.log(`Record with Airtable ID ${airtableRecordId} has changes. Updating the following fields: ${Object.keys(fieldsToUpdate).join(', ')}`);

          // Prepare the update data with only changed fields
          const updateData = { fieldData: fieldsToUpdate };

          try {
            const updateURL = `${webflowBaseURL}/${webflowRecord.id}`;
            const webflowUpdateResponse = await axios.patch(updateURL, updateData, { headers: webflowHeaders });
            console.log(`Successfully updated record in Webflow:`, webflowUpdateResponse.data);
          } catch (webflowError) {
            console.error(`Error updating record in Webflow:`, webflowError.response?.data || webflowError.message);
          }
        } else {
          console.log(`Record with Airtable ID ${airtableRecordId} is up to date in Webflow. No update needed.`);
        }
      } else {
        // If record doesn't exist in Webflow, create a new one
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
            "total-amount": String(record.fields["Amount Total"]),
            "purchase-class-name": biawClassesDetails[0]?.Name || "",
            "purchased-class-end-date": biawClassesDetails[0]?.["End date"] || "",
            "purchased-class-end-time": biawClassesDetails[0]?.["End Time"] || "",
            "purchased-class-start-date": biawClassesDetails[0]?.Date || "",
            "purchased-class-start-time": biawClassesDetails[0]?.["Start Time"] || "",
            "payment-status": record.fields["Payment Status"],
            "image": biawClassesDetails[0]?.Images?.[0]?.url || "",
            "number-of-purchased-seats": String(record.fields["Number of seat Purchased"]),
            "purchase-record-airtable-id": airtableRecordId,
            "payment-intent-2": record.fields["Payment ID"]
          },
        };

        // Create a new record in Webflow
        try {
          const webflowResponse = await axios.post(webflowBaseURL, webflowData, { headers: webflowHeaders });
          console.log(`Successfully pushed new record to Webflow:`, webflowResponse.data);
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

//class publish 
async function publishStagedItems2() {
  try {
    // Fetch all collections for the site
    const collectionsResponse2 = await axios.get(`${API_BASE_URL}/sites/${SITE_ID}/collections`, {
      headers: {
        Authorization: `Bearer ${WEBFLOW_API_KEY}`,
        "Accept-Version": "1.0.0",
      },
    });

    const collections2 = collectionsResponse2.data.collections || [];
    if (!collections2.length) {
      console.log("No collections found.");
      return;
    }

    console.log(
      "Available Collections:",
      collections2.map((col) => ({
        id: col.id,
        name: col.displayName,
        slug: col.slug,
      }))
    );

    const targetCollection2 = collections2.find(
      (collection) => collection.displayName === "Classes"
    );

    if (!targetCollection2) {
      console.log("Target collection not found. Ensure the collection name matches exactly.");
      return;
    }

    const COLLECTION_ID2 = targetCollection2.id;
    console.log(`Using Collection ID: ${COLLECTION_ID2}`);

    const itemsResponse = await axios.get(`${API_BASE_URL}/collections/${COLLECTION_ID2}/items`, {
      headers: {
        Authorization: `Bearer ${WEBFLOW_API_KEY}`,
        "Accept-Version": "1.0.0",
      },
    });

    const items = itemsResponse.data.items || [];

    const stagedItemIds2 = items
      .filter((item) => item.lastPublished === null)
      .map((item) => item.id);

    if (!stagedItemIds2.length) {
      console.log("No staged items found to publish.");
      return;
    }

    console.log(`Found staged items: ${stagedItemIds2}`);

    const publishResponse = await axios.post(
      `${API_BASE_URL}/collections/${COLLECTION_ID2}/items/publish`,
      { itemIds: stagedItemIds2 },
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
publishStagedItems2();

async function runPeriodicallys2(intervalMs) {
  console.log("Starting periodic sync2...");
  setInterval(async () => {
    console.log(`Running sync at ${new Date().toISOString()}`);
    await publishStagedItems2();
  }, intervalMs);
}

runPeriodicallys2(30 * 1000);

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


app.post("/cancel-payment", async (req, res) => {
  const { airtableRecordId } = req.body;

  if (!airtableRecordId) {
    return res.status(400).json({ message: "Missing Airtable Record ID" });
  }

  try {
    // Fetch the payment record from Airtable
    const airtableURL = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${AIRTABLE_TABLE_NAME}/${airtableRecordId}`;
    const recordResponse = await axios.get(airtableURL, {
      headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}` },
    });

    const currentPaymentStatus = recordResponse.data.fields["Payment Status"];
    const seatCount = recordResponse.data.fields["Number of seat Purchased"];
    const classID = recordResponse.data.fields["Biaw Classes"][0]; // Assuming this is an array of class IDs

    // Determine the new payment status based on the current "Payment Status"
    let newPaymentStatus = "Cancelled Without Refund"; // Default status
    if (currentPaymentStatus === "ROII-Free") {
      newPaymentStatus = "ROII-Cancelled";
    }

    // Prepare the update payload for payment status
    const fieldsToUpdate = {
      "Payment Status": newPaymentStatus,
    };

    // If the status is updated to "ROII-Cancelled", also update the "Number of seat Purchased" to 0
    if (newPaymentStatus === "ROII-Cancelled") {
      fieldsToUpdate["Number of seat Purchased"] = 0; // Set the number of seats to 0
    }

    // Update the payment status in Airtable
    await axios.patch(
      airtableURL,
      { fields: fieldsToUpdate },
      { headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}`, "Content-Type": "application/json" } }
    );

    // Now, update the "Biaw Classes" table with the updated seat counts
    const biawClassesURL = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/Biaw Classes/${classID}`;
    const biawClassResponse = await axios.get(biawClassesURL, {
      headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}` },
    });

    const currentSeatsRemaining = parseInt(biawClassResponse.data.fields["Number of seats remaining"], 10);
    const totalPurchasedSeats = parseInt(biawClassResponse.data.fields["Total Number of Purchased Seats"] || "0", 10);

    // Update the "Number of seats remaining" and "Total Number of Purchased Seats"
    const updatedSeatsRemaining = currentSeatsRemaining + seatCount;
    const updatedTotalPurchasedSeats = totalPurchasedSeats - seatCount;

    // Now, update the "Biaw Classes" table
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

    console.log(`Updated payment status and seats for class ${classID}`);
    res.status(200).json({
      message: "Payment status updated and class seat information adjusted",
      recordId: airtableRecordId,
    });
  } catch (error) {
    console.error("Error updating Airtable:", error.message);
    res.status(500).json({ message: "Failed to update Airtable", error: error.message });
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


