# Rust Ownership

Every value has exactly one owner, and when that owner goes out of scope the
value is dropped. Assigning a non-Copy value to another binding moves it, after
which the original binding can no longer be used — that is why the compiler
complains about a "value used after move."

Borrowing lets you reference data without taking ownership. You may have many
shared references or exactly one mutable reference, never both at once, which is
how the borrow checker rules out data races at compile time.

Lifetimes are just the compiler proving that a reference never outlives the data
it points to.
