const products = Array.from(document.querySelectorAll(".product"));

const searchInput = document.getElementById("searchInput");
const locationInput = document.getElementById("locationInput");
const searchButton = document.getElementById("searchButton");
const resultCount = document.getElementById("resultCount");
const emptyState = document.getElementById("emptyState");


function filterProducts() {

    const search = searchInput.value.trim().toLowerCase();

    let visible = 0;

    products.forEach(product => {

        const name = product.dataset.name.toLowerCase();
        const category = product.dataset.category.toLowerCase();

        const matches =
            !search ||
            name.includes(search) ||
            category.includes(search);

        if (matches) {
            product.style.display = "";
            visible++;
        } else {
            product.style.display = "none";
        }

    });


    resultCount.textContent =
        visible + (visible > 1 ? " produits" : " produit");


    emptyState.style.display =
        visible === 0 ? "block" : "none";
}



searchButton.addEventListener("click", filterProducts);



searchInput.addEventListener("keydown", event => {

    if (event.key === "Enter") {
        filterProducts();
    }

});



document.querySelectorAll("[data-search]").forEach(button => {

    button.addEventListener("click", () => {

        searchInput.value = button.dataset.search;

        filterProducts();

        document
            .getElementById("produits")
            .scrollIntoView({
                behavior: "smooth"
            });

    });

});



document.querySelectorAll("[data-category]").forEach(button => {

    button.addEventListener("click", () => {

        searchInput.value = button.dataset.category;

        filterProducts();

        document
            .getElementById("produits")
            .scrollIntoView({
                behavior: "smooth"
            });

    });

});



document.getElementById("showAll").addEventListener("click", () => {

    searchInput.value = "";
    locationInput.value = "";

    filterProducts();

});



document.getElementById("resetSearch").addEventListener("click", () => {

    searchInput.value = "";
    locationInput.value = "";

    filterProducts();

});



/* FAVORIS */

document.querySelectorAll(".favorite").forEach(button => {

    button.addEventListener("click", event => {

        event.stopPropagation();

        button.classList.toggle("active");

        button.textContent =
            button.classList.contains("active")
            ? "♥"
            : "♡";

    });

});



/* MODALES */

const productModal = document.getElementById("productModal");
const sellModal = document.getElementById("sellModal");
const modalProductContent = document.getElementById("modalProductContent");



function openModal(modal) {

    modal.classList.add("open");

    document.body.style.overflow = "hidden";

}



function closeModal(modal) {

    modal.classList.remove("open");

    document.body.style.overflow = "";

}



document.querySelectorAll("[data-close]").forEach(button => {

    button.addEventListener("click", () => {

        const modal =
            document.getElementById(button.dataset.close);

        closeModal(modal);

    });

});



document.querySelectorAll(".modal").forEach(modal => {

    modal.addEventListener("click", event => {

        if (event.target === modal) {

            closeModal(modal);

        }

    });

});



document.addEventListener("keydown", event => {

    if (event.key === "Escape") {

        closeModal(productModal);
        closeModal(sellModal);

    }

});



/* VOIR PRODUIT */

document.querySelectorAll(".view-product").forEach(button => {

    button.addEventListener("click", () => {

        const product = button.closest(".product");

        const name = product.dataset.name;
        const category = product.dataset.category;

        const price =
            product.querySelector(".product-bottom strong")
            .textContent
            .trim();


        const description =
            product.querySelector(".product-body p")
            .textContent
            .trim();


        const image =
            product.querySelector(".product-image svg");


        modalProductContent.innerHTML = "";


        const imageBox = document.createElement("div");

        imageBox.className = "modal-product-image";

        imageBox.appendChild(image.cloneNode(true));


        modalProductContent.appendChild(imageBox);


        modalProductContent.innerHTML += `

            <span class="product-category">
                ${category}
            </span>

            <h2>${name}</h2>

            <p class="modal-intro">
                ${description}
            </p>

            <strong style="font-size:24px">
                ${price}
            </strong>

            <button class="btn btn-dark full" style="margin-top:25px">
                Contacter le vendeur
            </button>

        `;


        openModal(productModal);

    });

});



/* OUVRIR VENTE */

function openSellModal() {

    openModal(sellModal);

}



document.getElementById("openSell")
.addEventListener("click", openSellModal);



document.getElementById("openSellBottom")
.addEventListener("click", openSellModal);



document.getElementById("footerSell")
.addEventListener("click", openSellModal);



/* FORMULAIRE */

document.getElementById("sellForm")
.addEventListener("submit", event => {

    event.preventDefault();


    alert(
        "Votre annonce est prête à être publiée."
    );


    event.target.reset();


    closeModal(sellModal);

});



/* DEMARRAGE */

filterProducts();
