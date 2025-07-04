const express = require("express");
const cors = require("cors");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
require("dotenv").config();
const stripe = require("stripe")(process.env.PAYMENT_GATEWAY_KEY);
const admin = require("firebase-admin");
const app = express();
const port = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());
const uri = process.env.MONGODB_URI;

const serviceAccount = require("./firebase-admin-key.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    // Connect the client to the server	(optional starting in v4.7)
    await client.connect();
    const db = client.db("fastshiftDB"); // your DB name
    parcelCollection = db.collection("parcels");
    paymentsCollection = db.collection("payments");
    usersCollection = db.collection("users");
    ridersCollection = db.collection("riders");

    // custom middleware //

    const verifyFBToken = async (req, res, next) => {
      const authHeader = req.headers.authorization;
      if (!authHeader) {
        return res.status(401).send({ message: "Unauthorized access" });
      }
      const token = authHeader.split(" ")[1];
      if (!token) {
        return res.status(401).send({ message: "Unauthorized access" });
      }

      //verify the token
      try {
        const decoded = await admin.auth().verifyIdToken(token);
        req.decoded = decoded;
        next();
      } catch (error) {
        return res.status(403).send({ message: "Forbidden access" });
      }
    };

    // Your POST API to add a parcel
    app.post("/parcels", async (req, res) => {
      const parcelData = req.body;

      try {
        const result = await parcelCollection.insertOne(parcelData);
        res.status(201).send({
          success: true,
          message: "Parcel added successfully",
          insertedId: result.insertedId,
        });
      } catch (error) {
        res.status(500).send({
          success: false,
          message: "Failed to add parcel",
          error: error.message,
        });
      }
    });

    // GET all parcels (no filter)
    app.get("/all-parcels", async (req, res) => {
      try {
        const parcels = await parcelCollection
          .find({})
          .sort({ created_at: -1 }) // Sort by latest
          .toArray();

        res.send({
          success: true,
          count: parcels.length,
          data: parcels,
        });
      } catch (error) {
        res.status(500).send({
          success: false,
          message: "🚫 Failed to fetch all parcels",
          error: error.message,
        });
      }
    });

    // GET parcels by user email (latest first)
    app.get("/my-parcels", verifyFBToken, async (req, res) => {
      const userEmail = req.query.email;
      console.log("decoded", req.decoded);
      if (req.decoded.email !== userEmail) {
        return res.status(403).send({ message: "Forbidden access" });
      }
      if (!userEmail) {
        return res.status(400).send({
          success: false,
          message: "❌ Please provide an email query parameter",
        });
      }

      try {
        const parcels = await parcelCollection
          .find({ created_by: userEmail })
          .sort({ creation_date: -1 })
          .toArray();

        res.send({
          success: true,
          count: parcels.length,
          data: parcels,
        });
      } catch (error) {
        res.status(500).send({
          success: false,
          message: "🚫 Failed to fetch parcels",
          error: error.message,
        });
      }
    });

    // GET single parcel by dynamic ID
    app.get("/all-parcels/:id", async (req, res) => {
      const parcelId = req.params.id;

      try {
        const parcel = await parcelCollection.findOne({
          _id: new ObjectId(parcelId),
        });

        if (!parcel) {
          return res.status(404).send({
            success: false,
            message: "❌ Parcel not found",
          });
        }

        res.send({
          success: true,
          data: parcel,
        });
      } catch (error) {
        res.status(500).send({
          success: false,
          message: "🚫 Failed to fetch parcel",
          error: error.message,
        });
      }
    });

    // GET: Get payment history (by user email or all if no email)
    app.get("/payments", verifyFBToken, async (req, res) => {
      try {
        const userEmail = req.query.email;
        if (req.decoded.email !== userEmail) {
          return res.status(403).send({ message: "Forbidden access" });
        }
        const query = userEmail ? { created_by: userEmail } : {};
        const options = { sort: { paid_at: -1 } }; // Sort latest first

        const payments = await paymentsCollection
          .find(query, options)
          .toArray();

        res.send({
          success: true,
          count: payments.length,
          data: payments,
        });
      } catch (error) {
        console.error("Error fetching payment history:", error);
        res.status(500).send({
          success: false,
          message: "Failed to get payments",
          error: error.message,
        });
      }
    });

    // POST : post users

    app.post("/users", async (req, res) => {
      const email = req.body.email;
      const userExist = await usersCollection.findOne({ email });
      if (userExist) {
        // update last login
        await usersCollection.updateOne(
          { email },
          { $set: { last_logged_in: new Date().toISOString() } }
        );

        return res
          .status(200)
          .send({ message: "User already exist", inserted: false });
      }
      const user = req.body;
      const result = await usersCollection.insertOne(user);
      res.send(result);
    });

    // POST: Mark parcel as paid + save payment history
    app.post("/payments", async (req, res) => {
      const { parcel_id, amount, transaction_id, created_by, payment_method } =
        req.body;

      if (!parcel_id || !amount || !transaction_id || !created_by) {
        return res
          .status(400)
          .send({ success: false, message: "Missing required fields" });
      }

      try {
        // 1. Update parcel payment_status
        const parcelUpdate = await parcelCollection.updateOne(
          { _id: new ObjectId(parcel_id) },
          { $set: { payment_status: "paid" } }
        );

        // 2. Save to payments collection
        const paymentDoc = {
          parcel_id: new ObjectId(parcel_id),
          amount,
          transaction_id,
          created_by,
          paid_at_string: new Date().toISOString(),
          paid_at: new Date(),
          payment_method,
        };

        const paymentResult = await paymentsCollection.insertOne(paymentDoc);

        res.send({
          success: true,
          message: "Payment recorded and parcel marked as paid",
          payment_id: paymentResult.insertedId,
        });
      } catch (err) {
        res.status(500).send({
          success: false,
          message: "Payment failed",
          error: err.message,
        });
      }
    });

    // post riders

    app.post("/riders", async (req, res) => {
      const rider = req.body;
      const result = await ridersCollection.insertOne(rider);
      res.send(result);
    });

    //get riders

    app.get("/riders/pending", async (req, res) => {
      try {
        const pendingRiders = await ridersCollection
          .find({ status: "pending" })
          .toArray();
        res.send(pendingRiders);
      } catch (error) {
        console.error("Failed to get pending riders:", error.message);
        res.status(500).send({ message: "Failed to fetch pending riders" });
      }
    });

    // GET /riders/active
    app.get("/riders/active", async (req, res) => {
      try {
        const activeRiders = await ridersCollection
          .find({ status: "active" })
          .toArray();
        res.send(activeRiders);
      } catch (error) {
        console.error("Error fetching active riders:", error);
        res.status(500).send({ message: "Internal Server Error" });
      }
    });

    // PATCH /riders/status/:id
    app.patch("/riders/status/:id", async (req, res) => {
      const { id } = req.params;
      const { status } = req.body;
      const result = await ridersCollection.updateOne(
        { _id: new ObjectId(id) },
        { $set: { status } }
      );
      res.send(result);
    });

    // parcel indend

    app.post("/create-payment-intent", async (req, res) => {
      const amountInCents = req.body.amountInCents;
      try {
        const paymentIntent = await stripe.paymentIntents.create({
          amount: amountInCents, // Amount in cents
          currency: "usd",
          payment_method_types: ["card"],
        });
        res.json({ clientSecret: paymentIntent.client_secret });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // DELETE a parcel by ID
    app.delete("/parcels/:id", async (req, res) => {
      const parcelId = req.params.id;

      try {
        const result = await parcelCollection.deleteOne({
          _id: new ObjectId(parcelId),
        });

        if (result.deletedCount === 1) {
          res.send({
            success: true,
            message: "✅ Parcel deleted successfully",
            deletedCount: result.deletedCount,
          });
        } else {
          res.status(404).send({
            success: false,
            message: "❌ Parcel not found",
          });
        }
      } catch (error) {
        res.status(500).send({
          success: false,
          message: "🚫 Failed to delete parcel",
          error: error.message,
        });
      }
    });

    // Test GET
    app.get("/", (req, res) => {
      res.send("🚀 FastShift Server is Running");
    });

    // Send a ping to confirm a successful connection
    await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!"
    );
  } finally {
    // Ensures that the client will close when you finish/error
    // await client.close();
  }
}
run().catch(console.dir);

// Routes
app.get("/", (req, res) => {
  res.send("FastShift server is running");
});

// Start Server
app.listen(port, () => {
  console.log(`FastShift server listening at port ${port}`);
});
