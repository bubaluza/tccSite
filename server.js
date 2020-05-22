const express = require('express');
const SerialPort = require('serialport');
const Readline = require('@serialport/parser-readline');
const regression = require('regression');

const parser = new Readline();
const pcVoc = 0.4, pcIsc = 0.1, pcS0i = 0.6, pcS0f = 0.92, pcS1f = 0.4, Vth=0.026;
let port,
    dinamicMeasure,
    ivMeasure,
    i,
    result,
    Voc,
    Isc,
    Vmp,
    Imp,
    Pmp,
    n,
    Io,
    Rso,
    Rsho,
    Rs,
    Rsh,
    Iph,
    FF,
    S0,
    S1,
    C,
    potencia,
    usbConnection = false,
    dadoPronto = false,
    po = [],
    pontos = [],
    chav0 = [],
    chav1 = [],
    progress,
    erro = false,
    measuring = false;


const app = express();

app.use(express.static('.'));
app.listen(8080, function () {
    console.log('app started');
});

//usb auto connection to ESP32

SerialPort.list((err, ports)=> {
    ports.forEach((_port) => {
        if (_port.manufacturer === 'Silicon Labs') {
            port = new SerialPort(_port.comName, {baudRate: 115200});
            port.pipe(parser);
            usbConnection = true;
        }
    });
});

//routes

app.get('/ajaxSet', (req, res) => {
    let rtn = {};
    rtn.chegou = false;
    if (!measuring) {
        port.write('r');
        progress = 0;
        measuring = true;
    }

    res.send(rtn);
});


//todo: change to ws
app.get('/ajaxConecao', (req, res) => {
    let rtn = {};
    rtn.conexao = usbConnection;
    res.send(rtn);
});

app.get('/ajaxMain', (req, res) => {
    let rtn = {};
    if (erro) {
        rtn.erro = true;
        erro = false;
    } else if (dadoPronto) {
        rtn.chegou = true;
        rtn.dadosIv = ivMeasure;
        rtn.pot = potencia;
        rtn.din = dinamicMeasure;
        rtn.maxima_potencia = Pmp;
        rtn.tensao_maxima_potencia = Vmp;
        rtn.corrente_maxima_potencia = Imp;
        rtn.corrente_cc = Isc;
        rtn.tensao_ca = Voc;
        rtn.rs = Rs;
        rtn.rp = Rsh;
        rtn.cd = C;
        dadoPronto = false;
    } else {
        rtn.chegou = false;
        rtn.progresso = progress;
    }
    res.send(rtn);
});

parser.on('data', line => {
    let json;
    try {
        json = JSON.parse(line);
    } catch (e) {
        console.log('JSON parse Error');
        return;
    }

    if (json.data) {
        try {
            po = [];
            potencia = [];
            chav0 = [];
            chav1 = [];
            pontos = [];
            ivMeasure = json.dataIv;
            dinamicMeasure = json.dataDin;

            ivMeasure = ivMeasure.filter(({voltage}) => voltage !== -1);

            po = ivMeasure.map(({voltage, current}) => ({
                voltage: voltage,
                power: voltage * current
            }));

            chav0 = first_chav = dinamicMeasure.filter( ({switching}) => switching === 0 );
            chav1 = second_chav = dinamicMeasure.filter( ({switching}) => switching === 1 );

            Voc = ivMeasure[0].voltage;
            Isc = ivMeasure[ivMeasure.length - 1].current;

            extractRes();
            extractCap();
            dadoPronto = true;
            measuring = false;
        } catch (e) {
            console.log(e);
            erro = true;
        }
    } else if (json.progresso >= 0) {
        progress = json.progresso;
    } else if (json.terminouIv == true) {
        port.write('a');
    }

});


function extractRes() {
    console.log("\nTensao x Corrente para 10% Voc");
    pontos = [];
    console.log(Voc * pcVoc);
    for (i = 0; ivMeasure[i].current < (Isc * pcIsc); i++) {
        let ponto = [];
        ponto[0] = ivMeasure[i].voltage;
        ponto[1] = ivMeasure[i].current;
        pontos.push(ponto);
        console.log(ivMeasure[i].voltage + " " + ivMeasure[i].current);
    }
    result = regression.linear(pontos, {precision: 5});
    Rso = -1 / result.equation[0];
    console.log("Rso: " + Rso);
    pontos = [];
    console.log("\nTensao x Corrente para 10% Isc");
    for (i = ivMeasure.length - 1; ivMeasure[i].voltage < (Voc * pcVoc); i--) {
        let ponto = [];
        if (ivMeasure[i].voltage != ivMeasure[i - 1].voltage) {
            ponto[0] = ivMeasure[i].voltage;
            ponto[1] = ivMeasure[i].current;
            pontos.push(ponto);
            console.log(ivMeasure[i].voltage + " " + ivMeasure[i].current);
        }
    }
    result = regression.linear(pontos, {precision: 5});
    Rsho = -1 / result.equation[0];
    console.log("Rsho: " + Rsho);
    calcPmp();
    calcCelik();
}

function extractCap() {
    console.log("\nTempo x Tensão");
    pontos = [];
    console.log("S0");
    for (i = 0; i < (chav0.length) * pcS0i; i++) ;
    for (i; i < (chav0.length) * pcS0f; i++) {
        let ponto = [];
        ponto[0] = chav0[i].time;
        ponto[1] = chav0[i].voltage;
        pontos.push(ponto);
        console.log(chav0[i].time + " " + chav0[i].voltage);
    }
    result = regression.linear(pontos, {precision: 5});
    S0 = result.equation[0];
    pontos = [];
    console.log("S1");
    for (i = 0; i < (chav1.length) * pcS1f; i++) {
        let ponto = [];
        ponto[0] = chav1[i].time;
        ponto[1] = chav1[i].voltage;
        pontos.push(ponto);
        console.log(chav1[i].time + " " + chav1[i].voltage);
    }
    result = regression.linear(pontos, {precision: 5});
    S1 = result.equation[0];
    console.log("S0 " + S0 + "S1 " + S1);
    C = (-S0 * 0.000022) / (S0 - S1);
    console.log("Capacitância interna: " + C);
}

function calcPmp() {
    let imaior = 0;

    for (i = 0; i < ivMeasure.length; i++) {
        if (po[i] > po[imaior]) {
            imaior = i;
        }
    }
    Vmp = ivMeasure[imaior].voltage;
    Imp = ivMeasure[imaior].current;
    Pmp = po[imaior];
    console.log('potencia: ' + Pmp);
}

function calcCelik() {
    Rsh = Rsho;
    n = (Vmp + Rso * Imp - Voc) / (Vth * (Math.log(Isc - Vmp / Rsho - Imp) - Math.log(Isc - Voc / Rsh) + Imp / (Isc - Voc / Rsho)));
    Io = (Isc - Voc / Rsh) * Math.exp(-Voc / (n * Vth));
    Rs = Rso - n * Vth * Math.exp(-Voc / (n * Vth)) / Io;
    Iph = Isc * (1 + Rs / Rsh) + Io * (Math.exp(Isc * Rs / (n * Vth) - 1));
    FF = (Vmp * Imp) / (Voc * Isc);
    console.log('n: ' + n);
    console.log('Io: ' + Io);
    console.log('Iph: ' + Iph);
}
