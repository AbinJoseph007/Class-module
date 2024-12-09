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


// Function to check and update payments
const checkAndPushPayments = async () => {
  try {
    console.log('Checking for new payments...');
    const charges = await stripes.charges.list({ limit: 1 });
    const latestCharge = charges.data[0];  

    if (!latestCharge) {
      console.log('No new payments found');
      return;
    }

    const paymentId = latestCharge.id;
    const amountTotal = latestCharge.amount / 100;  
    const paymentStatus = latestCharge.status;
    const email = latestCharge.billing_details?.email || null;

    if (!email) {
      console.log('No email found in Stripe payment details');
      return;
    }

    console.log('Latest Charge:', { paymentId, amountTotal, paymentStatus, email });

    const matchingRecords = await airtableBase(AIRTABLE_TABLE_NAME3)
      .select({ filterByFormula: `{Email} = '${email}'` })  // Match by email
      .firstPage();

    if (matchingRecords.length > 0) {
      const recordId = matchingRecords[0].id;
      const updatedFields = {
        "Payment ID": paymentId,
        "Amount Total": new Intl.NumberFormat('en-US', {
          style: 'currency',
          currency: 'USD',
        }).format(amountTotal),  
        "Payment Status": paymentStatus === 'succeeded' ? 'Paid' : 'Failed',
      };
      console.log('Updating existing record in Airtable:', updatedFields);
      await airtableBase(AIRTABLE_TABLE_NAME3).update(recordId, updatedFields);
      console.log('Payment record successfully updated in Airtable.');
    } else {
      console.log('No matching email found in Airtable.');
    }
  } catch (error) {
    console.error('Error in checkAndPushPayments:', error);
  }
};

cron.schedule('*/1 * * * *', async () => {
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
    }, 10 * 60 * 1000); 
  } catch (error) {
    logError("Initial Process", error);
  }
}

// Start the periodic process
processNewClassesPeriodically();



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


